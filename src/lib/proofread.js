/*
  Rilettura contestuale in italiano — cattura la classe di errori OCR che né il
  controllo di fedeltà (azzera gli accenti) né lo spellchecker a dizionario
  («e», «si», «osservano» sono parole valide) possono vedere:

    • accenti caduti sugli OMOGRAFI: «è»→«e», «sì»→«si», «È»→«E»;
    • parole-funzione saltate dall'OCR nei vuoti («terapia  sempre» → «è sempre»);
    • caporali « » non bilanciate.

  È un intervento LLM, quindi potenzialmente rischioso. Il guard lo rende sicuro:
  il modello può SOLO aggiungere accenti/virgolette/spazi o INSERIRE parole
  mancanti; non può rimuovere, riordinare o alterare le parole esistenti. Ogni
  paragrafo corretto è accettato solo se le parole originali (senza accenti)
  restano una SOTTOSEQUENZA di quelle corrette; altrimenti si tiene l'originale.

  Per non toccare la sintassi Typst, si inviano al modello SOLO i paragrafi di
  prosa pura: quelli con codice inline (#funzioni, math $…$, figure, preambolo)
  vengono saltati e lasciati identici.
*/

import { nvidiaChat } from './nvidia.js';
import { geminiGenerate } from './gemini.js';
import { extractJson } from './aifix.js';

const SYSTEM =
  'Sei un correttore di bozze madrelingua italiano, esperto di testi ' +
  'accademici. Il testo proviene dall’OCR di una scansione di scarsa qualità. ' +
  'Rispondi SOLTANTO con JSON valido.';

/**
 * Un paragrafo è "prosa pura" (inviabile al modello) se NON contiene sintassi
 * Typst: niente titoli `=`, funzioni `#…`, math `$…$`, commenti, figure o
 * righe di preambolo. I paragrafi con codice inline restano intatti.
 */
export function isPlainProse(p) {
  const s = p.trim();
  if (!s) return false;
  if (/^[=+\-]/.test(s)) return false; // titoli, liste, righe speciali
  if (/^#/.test(s)) return false; // #set/#show/#let/#figure a inizio riga
  if (/#[a-zA-Z]/.test(s)) return false; // funzioni Typst inline (#footnote…)
  if (/\$[^$]*\$/.test(s)) return false; // matematica inline
  if (/<!--|-->/.test(s)) return false; // marcatori di pagina
  if (/!\[[^\]]*\]\([^)]*\)/.test(s)) return false; // figure Markdown residue
  if (/\]\(|\)\s*$/.test(s) && /\[/.test(s)) return false; // link/immagini
  return true;
}

/**
 * Divide il testo in blocchi alternati [testo, separatore, testo, …] così che
 * `blocks.join('')` ricostruisca ESATTAMENTE l'originale (separatori = righe
 * vuote). I blocchi in posizione pari sono i paragrafi.
 */
export function splitParagraphs(text) {
  // Cattura i separatori (una o più righe vuote) per una ricomposizione fedele.
  return text.split(/(\n[ \t]*\n[\s]*)/);
}

/** Parole (solo lettere, minuscole, senza accenti) per il confronto del guard. */
export function contentWords(s) {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '') // via i diacritici: «è»→«e», «più»→«piu»
    .replace(/[^a-z]+/g, ' ') // solo lettere: numeri e simboli non pesano
    .trim()
    .split(' ')
    .filter(Boolean);
}

/** true se `a` è una sottosequenza di `b` (stesso ordine, ammesse inserzioni). */
export function isSubsequence(a, b) {
  let i = 0;
  for (let j = 0; j < b.length && i < a.length; j++) {
    if (a[i] === b[j]) i++;
  }
  return i === a.length;
}

/**
 * Un paragrafo corretto è sicuro se non ha PERSO né CAMBIATO parole: le parole
 * originali devono restare, nell'ordine, dentro quelle corrette (sono ammesse
 * solo inserzioni, es. una «è» saltata). Vieta anche inserzioni sregolate.
 */
export function isSafeCorrection(orig, corr) {
  const a = contentWords(orig);
  const b = contentWords(corr);
  if (!b.length) return false;
  if (b.length > a.length + Math.ceil(a.length * 0.15) + 3) return false; // troppe aggiunte
  return isSubsequence(a, b);
}

/**
 * Chiede al modello (forte, quello delle correzioni) di rileggere un lotto di
 * paragrafi, restituendo per ciascuno il testo corretto. Solo accenti, parole
 * saltate e virgolette: nessun rimaneggiamento del contenuto.
 * @returns {Promise<Map<number,string>>} indice → testo corretto
 */
export async function requestProofread({ settings, paragraphs, signal }) {
  const user =
    'Correggi SOLO questi errori tipici dell’OCR, senza cambiare le parole:\n' +
    '1) accenti caduti sugli omografi: «è» (verbo essere) scritto «e», «sì» ' +
    'scritto «si», «È» a inizio frase scritto «E», e ogni accento mancante ' +
    '(più, perché, città, poté…);\n' +
    '2) parole brevi saltate dall’OCR dove resta un vuoto/doppio spazio ' +
    '(spesso la «è»): reinseriscile;\n' +
    '3) caporali «» non bilanciate: chiudile/aprile correttamente.\n' +
    'NON tradurre, NON riassumere, NON riscrivere, NON aggiungere o togliere ' +
    'concetti, NON cambiare parole corrette. Mantieni identici ordine, ' +
    'contenuto e la formattazione Markdown (_corsivo_, ecc.). Se un paragrafo ' +
    'è già corretto, riportalo invariato.\n\nPARAGRAFI:\n' +
    paragraphs.map((p, i) => `[${i}] ${p}`).join('\n\n') +
    '\n\nRispondi SOLO con: {"items":[{"i":0,"text":"…"}, …]} includendo un ' +
    'oggetto per OGNI paragrafo.';

  let text;
  if (settings.fixEngine === 'gemini') {
    text = await geminiGenerate({
      apiKey: settings.googleApiKey,
      model: settings.fixModel,
      system: SYSTEM,
      user,
      temperature: 0,
      maxTokens: 8192,
      json: true,
      signal,
    });
  } else {
    text = await nvidiaChat({
      apiKey: settings.nvidiaApiKey,
      endpoint: settings.nvidiaEndpoint,
      model: settings.fixModel,
      system: SYSTEM,
      user,
      temperature: 0,
      maxTokens: 8192,
      signal,
    });
  }
  const parsed = extractJson(text);
  const items = Array.isArray(parsed.items) ? parsed.items : [];
  const map = new Map();
  for (const it of items) {
    if (it && Number.isInteger(it.i) && typeof it.text === 'string') {
      map.set(it.i, it.text);
    }
  }
  return map;
}

/**
 * Rilegge tutto il corpo Typst: individua i paragrafi di prosa pura, li invia
 * a lotti al modello, applica SOLO le correzioni che superano il guard di
 * sicurezza e ricompone il documento byte-per-byte attorno alle parti di codice.
 *
 * @param {object} p
 * @param {object} p.settings
 * @param {string} p.code            corpo Typst
 * @param {number} [p.batchSize]     paragrafi per richiesta
 * @param {AbortSignal} [p.signal]
 * @param {(done:number,total:number)=>void} [p.onProgress]
 * @returns {Promise<{code:string, checked:number, changed:number, skipped:number,
 *   changes:{before:string, after:string}[]}>}
 */
export async function proofreadBody({ settings, code, batchSize = 12, signal, onProgress }) {
  const blocks = splitParagraphs(code);
  // Indici (nell'array blocks) dei paragrafi di prosa pura, con il loro testo.
  const targets = [];
  for (let b = 0; b < blocks.length; b += 2) {
    if (isPlainProse(blocks[b])) targets.push(b);
  }

  const changes = [];
  let changed = 0;
  let skipped = 0;
  let done = 0;

  for (let start = 0; start < targets.length; start += batchSize) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const batch = targets.slice(start, start + batchSize);
    const paragraphs = batch.map((b) => blocks[b]);
    let map;
    try {
      map = await requestProofread({ settings, paragraphs, signal });
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      // Un lotto fallito non blocca il resto: quei paragrafi restano intatti.
      map = new Map();
    }
    batch.forEach((b, k) => {
      const before = blocks[b];
      const after = map.get(k);
      if (typeof after === 'string' && after.trim() && after !== before && isSafeCorrection(before, after)) {
        blocks[b] = after;
        changed++;
        changes.push({ before, after });
      } else if (typeof after === 'string' && after !== before) {
        skipped++; // proposta scartata dal guard
      }
    });
    done += batch.length;
    onProgress?.(done, targets.length);
  }

  return { code: blocks.join(''), checked: targets.length, changed, skipped, changes };
}
