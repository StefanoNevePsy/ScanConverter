/*
  Modelli consigliati per Ollama e loro installazione dall'app.

  Ollama espone /api/pull: si chiede il modello e arriva l'avanzamento come
  righe JSON successive. Lo stesso indirizzo usato per la chat, senza
  /v1/chat/completions.
*/

import { DEFAULT_LOCAL_ENDPOINT } from './local.js';

export const RECOMMENDED_MODELS = [
  {
    name: 'gemma4:e4b',
    label: 'Gemma 4 E4B',
    size: '~6 GB',
    note: 'Piccolo e veloce, forte nelle lingue europee. Buono per concordanze e coniugazioni.',
    phases: ['proof', 'translate'],
  },
  {
    name: 'hf.co/unsloth/Inkling-2-Mini-GGUF:UD-Q2_K_XL',
    label: 'Inkling 2 Mini (Q2)',
    size: '~9,1 GB',
    note: 'Thinking Machines, 26,4B MoE con 3,4B attivi, Apache 2.0. Scelta sicura per PC con GPU da 10 GB. Richiede un Ollama recente.',
    phases: ['proof', 'fix'],
  },
  {
    name: 'hf.co/unsloth/Inkling-2-Mini-GGUF:UD-IQ3_XXS',
    label: 'Inkling 2 Mini (IQ3)',
    size: '~11,7 GB',
    note: 'Stesso modello, quantizzazione migliore: per Mac da 16 GB quando conta la qualità. Richiede un Ollama recente.',
    phases: ['proof', 'fix'],
  },
  {
    name: 'richardyoung/lightonocr-3-1b',
    label: 'LightOnOCR-3 1B',
    size: '~1,5 GB',
    note: 'Build della comunità (Q8_0 con parte visiva inclusa): piccolo e veloce per la lettura OCR.',
    phases: ['ocr'],
  },
  {
    name: 'richardyoung/lightonocr-3-4b:Q6_K',
    label: 'LightOnOCR-3 4B',
    size: '~3,8 GB',
    note: 'Build della comunità (Q6_K + parte visiva): più preciso del 1B, sta in un Mac da 16 GB e in una GPU da 10 GB.',
    phases: ['ocr'],
  },
  {
    name: 'gemma4:12b',
    label: 'Gemma 4 12B',
    size: '~7,6 GB',
    note: 'Il più accurato dei consigliati. Sta al limite in una scheda video da 10 GB.',
    phases: ['proof', 'translate'],
  },
];

/** Indirizzo base di Ollama a partire da quello della chat. */
export function ollamaBase(endpoint) {
  return String(endpoint || DEFAULT_LOCAL_ENDPOINT).replace(/\/v1\/chat\/completions\/?$/, '').replace(/\/$/, '');
}

/**
 * Scarica un modello in Ollama, riportando l'avanzamento.
 * @param {{endpoint:string, model:string, onProgress?:(text:string, pct?:number)=>void, signal?:AbortSignal}} p
 */
export async function pullOllamaModel({ endpoint, model, onProgress, signal }) {
  let res;
  try {
    res = await fetch(`${ollamaBase(endpoint)}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: true }),
      signal,
    });
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    throw new Error('Ollama non risponde: è installato e acceso?');
  }
  if (!res.ok || !res.body) throw new Error(`Ollama ha risposto ${res.status}.`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.error) throw new Error(`Ollama: ${msg.error}`);
      const pct = msg.total ? Math.round((msg.completed / msg.total) * 100) : undefined;
      const gb = msg.total ? ` · ${(msg.completed / 1e9).toFixed(1)}/${(msg.total / 1e9).toFixed(1)} GB` : '';
      onProgress?.(`${msg.status || 'download'}${gb}`, pct);
    }
  }
}

// Controlli già superati (endpoint + modello): niente richiesta a ogni pagina.
const verifiedModels = new Set();

/** «nome» e «nome:latest» sono lo stesso modello. */
function sameModel(a, b) {
  const norm = (n) => (String(n).includes(':') ? String(n) : `${n}:latest`).toLowerCase();
  return norm(a) === norm(b);
}

/**
 * Si assicura che il modello sia in Ollama: se manca lo scarica, con avanzamento.
 * @param {{endpoint:string, model:string, onProgress?:(text:string, pct?:number)=>void, signal?:AbortSignal}} p
 */
export async function ensureOllamaModel({ endpoint, model, onProgress, signal }) {
  const key = `${ollamaBase(endpoint)}|${model}`;
  if (verifiedModels.has(key)) return;
  let installed;
  try {
    const res = await fetch(`${ollamaBase(endpoint)}/api/tags`, { signal });
    if (!res.ok) throw new Error(`Ollama ha risposto ${res.status}.`);
    const data = await res.json();
    installed = (data?.models || []).map((m) => m.name || m.model).filter(Boolean);
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    const err = new Error(`Ollama non è raggiungibile: avvialo e riprova. Dettaglio: ${e.message}`);
    err.local = true;
    throw err;
  }
  if (!installed.some((n) => sameModel(n, model))) {
    try {
      await pullOllamaModel({ endpoint, model, onProgress, signal });
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      const err = new Error(`Non sono riuscito a scaricare il modello «${model}» in Ollama: ${e.message}`);
      err.local = true;
      throw err;
    }
  }
  verifiedModels.add(key);
}
