/*
  OCR con un modello di visione su Ollama (PaddleOCR-VL o un modello generico
  come Qwen-VL), dal computer dell'utente: niente account, niente quote, le
  pagine non escono dalla macchina.

  Differenza con il server di Baidu: qui il modello restituisce solo TESTO,
  senza dire cosa è un titolo né dove sta sulla pagina. Per non perdere la
  struttura:
  - ai modelli generici si chiede direttamente Markdown, con i titoli marcati;
  - per PaddleOCR-VL (che trascrive e basta) i titoli si riconoscono con
    regole sul testo: righe brevi, senza punto finale, seguite da un
    paragrafo, oppure in maiuscolo o numerate («ABILITÀ 1: …»).
  I livelli li decidono poi le stesse regole fisse di sempre.
*/

import { DEFAULT_LOCAL_ENDPOINT } from './local.js';

export const DEFAULT_OLLAMA_OCR_MODEL = 'MedAIBase/PaddleOCR-VL:0.9b';

const isPaddle = (model) => /paddleocr/i.test(String(model || ''));

const MARKDOWN_PROMPT =
  'Trascrivi ESATTAMENTE il testo di questa pagina di libro in Markdown. ' +
  'Marca i titoli con # (titolo di capitolo), ## (sezione), ### (sottosezione) ' +
  'secondo la loro evidenza grafica. Elenchi puntati con «- », numerati con «1. ». ' +
  'Ometti testatina e numero di pagina. Non tradurre, non correggere, non ' +
  'aggiungere commenti: solo il testo della pagina.';

const END_PUNCT = /[.,;:!?…»”"')\]]$/u;
const LIST_LINE = /^\s*(?:[-–•·*]\s+|\d{1,3}[.)]\s+|\\\(\\bullet\\\))/u;

/** Una riga che ha l'aspetto di un titolo. */
function looksLikeHeading(line, next) {
  const t = line.trim();
  if (t.length < 3 || t.length > 90) return false;
  if (LIST_LINE.test(t) || /^\d{1,4}$/.test(t)) return false;
  const words = t.split(/\s+/).length;
  if (words > 12) return false;
  const letters = t.replace(/[^\p{L}]/gu, '');
  const caps = letters.length >= 4 && letters === letters.toUpperCase();
  const labelled = /^[\p{L}]{3,}\s+\d{1,3}\s*[:.–—-]\s*\S/u.test(t);
  if (caps || labelled) return true;
  if (END_PUNCT.test(t) || !/^[\p{Lu}]/u.test(t)) return false;
  // Un titolo in minuscolo è seguito da un paragrafo, non da un'altra riga breve.
  return Boolean(next && next.trim().length > 60);
}

/**
 * Testo semplice dell'OCR → Markdown a blocchi: titoli marcati, paragrafi
 * ricomposti (righe unite, sillabazioni a fine riga sciolte), voci d'elenco
 * separate. Pura: si prova senza Ollama.
 */
export function plainOcrToMarkdown(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const blocks = [];
  let para = '';
  const flush = () => {
    if (para.trim()) blocks.push(para.trim());
    para = '';
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) {
      flush();
      continue;
    }
    const next = lines.slice(i + 1).find((l) => l.trim());
    if (/^#{1,6}\s/.test(line)) {
      flush();
      blocks.push(line);
    } else if (looksLikeHeading(line, next) && (!para || /[.!?…»”"]$/u.test(para))) {
      // Un titolo arriva dopo una frase conclusa, non a metà di un periodo.
      flush();
      blocks.push(`## ${line}`);
    } else if (LIST_LINE.test(line)) {
      flush();
      para = line;
    } else if (para && /[\p{L}]-$/u.test(para) && /^[\p{Ll}]/u.test(line)) {
      para = para.slice(0, -1) + line; // «ne-» + «cessari»
    } else {
      para = para ? `${para} ${line}` : line;
    }
  }
  flush();
  return blocks.join('\n\n');
}

/** Compito → richiesta. PaddleOCR-VL è addestrato su richieste brevissime. */
const PADDLE_TASKS = {
  text: 'OCR:',
  table: 'Table Recognition:',
  formula: 'Formula Recognition:',
  page: 'OCR:',
};
const GENERIC_TASKS = {
  text: 'Trascrivi ESATTAMENTE il testo di questa immagine, riga per riga. Solo il testo, senza commenti.',
  table: 'Trascrivi questa tabella come tabella Markdown, cella per cella. Solo la tabella.',
  formula: 'Trascrivi questa formula in LaTeX. Solo la formula.',
  page: MARKDOWN_PROMPT,
};

/**
 * Una richiesta di lettura a un modello di visione su Ollama.
 * @param {{endpoint?:string, model?:string, imageDataUrl:string, task?:'text'|'table'|'formula'|'page', signal?:AbortSignal}} p
 * @returns {Promise<string>} testo grezzo
 */
export async function ollamaRecognize({ endpoint, model, imageDataUrl, task = 'text', signal }) {
  const target = String(endpoint || DEFAULT_LOCAL_ENDPOINT).trim();
  const name = String(model || DEFAULT_OLLAMA_OCR_MODEL).trim();
  const prompt = (isPaddle(name) ? PADDLE_TASKS : GENERIC_TASKS)[task] || PADDLE_TASKS.text;
  let res;
  try {
    res = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: name,
        temperature: 0,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: imageDataUrl } },
              { type: 'text', text: prompt },
            ],
          },
        ],
        max_tokens: task === 'page' ? 4096 : 2048,
      }),
      signal,
    });
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    const err = new Error(
      `Ollama non è raggiungibile su ${target}. Avvialo (o installalo da Impostazioni → Sul computer). Dettaglio: ${e.message}`,
    );
    err.local = true;
    throw err;
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const missing = res.status === 404 || /not found|pull/i.test(detail);
    // Il modello c'è ma Ollama non gli sa passare immagini (manca la parte
    // «visiva», mmproj): succede con PaddleOCR-VL su versioni di Ollama che
    // non lo supportano ancora del tutto.
    const noVision = /image input is not supported|mmproj/i.test(detail);
    const err = new Error(
      missing
        ? `Il modello «${name}» non è scaricato in Ollama: installalo da Impostazioni → Lettura.`
        : noVision
          ? `Ollama non riesce a dare immagini al modello «${name}». Aggiorna Ollama all’ultima versione e riscarica il modello; se non basta, in Impostazioni → Lettura usa un modello di visione generico (es. qwen3.5:9b o gemma4:e4b) oppure PaddleOCR online.`
          : `Ollama ha avuto un problema con la pagina: ${detail.slice(0, 300)}`,
    );
    err.local = true;
    throw err;
  }
  const data = await res.json();
  let text = data?.choices?.[0]?.message?.content || '';
  if (Array.isArray(text)) text = text.map((p) => p?.text || '').join('');
  return String(text)
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/^```(?:markdown|latex)?\s*|\s*```$/g, '')
    .trim();
}

/**
 * OCR di una pagina intera via Ollama (senza analisi dell'impaginazione).
 * @returns {Promise<Array<{type:string,bbox:null,text:string}>>}
 */
export async function ollamaOcrBlocks({ endpoint, model, imageDataUrl, signal }) {
  const name = String(model || DEFAULT_OLLAMA_OCR_MODEL).trim();
  const text = await ollamaRecognize({ endpoint, model: name, imageDataUrl, task: 'page', signal });
  if (!text) {
    const err = new Error(`Il modello «${name}» non ha restituito testo per questa pagina.`);
    err.local = true;
    throw err;
  }
  return [{ type: 'Text', bbox: null, text: isPaddle(name) ? plainOcrToMarkdown(text) : text }];
}
