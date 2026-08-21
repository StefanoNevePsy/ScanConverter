/*
  Motore LOCALE — un server OpenAI-compatibile in esecuzione sulla macchina
  dell'utente (Ollama, LM Studio, llama.cpp, vLLM).

  Perché è quasi gratis aggiungerlo: Ollama espone
  `http://localhost:11434/v1/chat/completions`, cioè ESATTAMENTE la stessa
  forma di richiesta che già usiamo per i NIM di NVIDIA. Non serve un nuovo
  protocollo: cambia l'URL e cade l'autenticazione.

  A cosa serve nella pipeline: l'OCR veloce (Nemotron OCR v2, ~84M parametri)
  riconosce i glifi ma non ha modello linguistico, quindi non può sapere che
  quella «e» è il verbo essere. Un LLM piccolo in locale copre proprio quel
  buco, con lo stesso guard deterministico già usato per Gemini e NVIDIA: il
  modello propone, il dizionario e la sottosequenza dispongono.
*/

export const DEFAULT_LOCAL_ENDPOINT = 'http://localhost:11434/v1/chat/completions';
export const DEFAULT_LOCAL_MODEL = 'qwen3:8b';
export const DEFAULT_LOCAL_OCR_ENDPOINT = 'http://localhost:8000/ocr';

/** Errore parlante: qui la causa è quasi sempre «il server non è avviato». */
function unreachable(endpoint, detail) {
  return new Error(
    `Server locale non raggiungibile su ${endpoint}. Avvia Ollama (o il ` +
      `sidecar OCR) e verifica l'indirizzo nelle impostazioni. Dettaglio: ${detail}`,
  );
}

/**
 * Chat OpenAI-compatibile verso il server locale. Nessuna chiave API: i
 * server locali non la richiedono (Ollama accetta qualunque stringa).
 * @param {object} p
 * @param {string} p.endpoint  URL chat/completions
 * @param {string} p.model     nome del modello caricato (es. "qwen3:8b")
 * @param {string} [p.system]
 * @param {string} p.user
 * @param {number} [p.temperature]
 * @param {number} [p.maxTokens]
 * @param {boolean} [p.json]   chiede una risposta in JSON, quando supportata
 * @param {AbortSignal} [p.signal]
 * @returns {Promise<string>}
 */
export async function localChat({
  endpoint = DEFAULT_LOCAL_ENDPOINT,
  model = DEFAULT_LOCAL_MODEL,
  system,
  user,
  temperature = 0.1,
  maxTokens = 4096,
  json = false,
  signal,
}) {
  const body = {
    model,
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content: user },
    ],
    temperature,
    max_tokens: maxTokens,
    stream: false,
    ...(json ? { response_format: { type: 'json_object' } } : {}),
  };

  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    throw unreachable(endpoint, e.message);
  }
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 300);
    } catch {
      /* corpo non leggibile */
    }
    throw new Error(`Il server locale ha risposto ${res.status}. ${detail}`);
  }

  const data = await res.json();
  const msg = data?.choices?.[0]?.message;
  let text = typeof msg?.content === 'string' ? msg.content : '';
  if (Array.isArray(msg?.content)) {
    text = msg.content.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('');
  }
  if (!text.trim()) {
    throw new Error('Il modello locale non ha restituito testo.');
  }
  // I modelli «reasoning» piccoli antepongono spesso il ragionamento fra tag.
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

/**
 * OCR locale: interroga il sidecar Python che incapsula Nemotron OCR v2 e
 * restituisce i blocchi nello stesso formato di Nemotron-Parse, così il resto
 * della pipeline (ordine di lettura, figure, assemblaggio) non cambia.
 *
 * @param {object} p
 * @param {string} p.endpoint      URL del sidecar
 * @param {string} p.imageDataUrl  data URL della pagina
 * @param {AbortSignal} [p.signal]
 * @returns {Promise<Array<{type:string,bbox:object|null,text:string}>>}
 */
export async function localOcrBlocks({
  endpoint = DEFAULT_LOCAL_OCR_ENDPOINT,
  imageDataUrl,
  signal,
}) {
  if (!imageDataUrl) throw new Error('Nessuna immagine da analizzare.');

  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: imageDataUrl }),
      signal,
    });
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    throw unreachable(endpoint, e.message);
  }
  if (!res.ok) {
    throw new Error(`Il sidecar OCR ha risposto ${res.status}.`);
  }

  const data = await res.json();
  const blocks = Array.isArray(data?.blocks) ? data.blocks : null;
  if (!blocks) throw new Error('Il sidecar OCR non ha restituito blocchi.');
  return normalizeLocalBlocks(blocks);
}

/**
 * Porta i blocchi del sidecar nella forma attesa dal resto della pipeline:
 * `type` fra quelli noti, `bbox` normalizzata 0–1, `text` stringa.
 * Esportata a parte perché è pura: è la sola parte testabile senza GPU.
 */
export function normalizeLocalBlocks(blocks) {
  const out = [];
  for (const b of blocks) {
    const text = typeof b?.text === 'string' ? b.text.trim() : '';
    if (!text) continue;
    const box = b.bbox;
    const bbox =
      box &&
      ['xmin', 'ymin', 'xmax', 'ymax'].every((k) => Number.isFinite(Number(box[k])))
        ? {
            xmin: clamp01(Number(box.xmin)),
            ymin: clamp01(Number(box.ymin)),
            xmax: clamp01(Number(box.xmax)),
            ymax: clamp01(Number(box.ymax)),
          }
        : null;
    out.push({ type: typeof b.type === 'string' && b.type ? b.type : 'Text', bbox, text });
  }
  return out;
}

const clamp01 = (n) => Math.min(1, Math.max(0, n));
