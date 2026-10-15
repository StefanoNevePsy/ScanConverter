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
    name: 'qwen3.5:4b',
    label: 'Qwen 3.5 4B',
    size: '~3 GB',
    note: 'Il più leggero: adatto al MacBook Air quando conta la velocità.',
    phases: ['proof'],
  },
  {
    name: 'qwen3.5:9b',
    label: 'Qwen 3.5 9B',
    size: '~6,6 GB',
    note: 'Più attento al contesto (frasi spezzate, termini tecnici), un po’ più lento.',
    phases: ['proof', 'fix'],
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
