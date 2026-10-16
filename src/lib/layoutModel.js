/*
  Modello di impaginazione PP-DocLayoutV3, eseguito DENTRO l'app con
  onnxruntime-web: scheda video (WebGPU) quando c'è, altrimenti processore
  (WebAssembly). Nessun programma da installare, nessun servizio esterno.

  Il modello (65 MB, Apache 2.0) si scarica la prima volta e resta nella
  cache del browser/dell'app: le volte successive si carica dal disco.
*/

import { INPUT_SIZE, parseLayoutOutput, toInputTensor } from './layoutRegions.js';

export const LAYOUT_MODEL_URL =
  'https://huggingface.co/traceray/nexus-layout/resolve/main/pp-doclayoutv3-w16.onnx';
const CACHE_NAME = 'scanconverter-models-v1';

let sessionPromise = null;

/** Scarica (o legge dalla cache) il modello, con avanzamento in 0–100. */
async function modelBytes(onProgress) {
  const cache = typeof caches !== 'undefined' ? await caches.open(CACHE_NAME).catch(() => null) : null;
  const cached = cache ? await cache.match(LAYOUT_MODEL_URL) : null;
  if (cached) return new Uint8Array(await cached.arrayBuffer());

  const res = await fetch(LAYOUT_MODEL_URL);
  if (!res.ok || !res.body) throw new Error(`Download del modello di impaginazione non riuscito (${res.status}).`);
  const total = Number(res.headers.get('content-length')) || 65751638;
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress?.(Math.min(99, Math.round((received / total) * 100)));
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  if (cache) await cache.put(LAYOUT_MODEL_URL, new Response(bytes)).catch(() => {});
  onProgress?.(100);
  return bytes;
}

/** True se il modello è già scaricato. */
export async function layoutModelReady() {
  if (typeof caches === 'undefined') return false;
  const cache = await caches.open(CACHE_NAME).catch(() => null);
  return Boolean(cache && (await cache.match(LAYOUT_MODEL_URL)));
}

async function session(onProgress) {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const ort = await import('onnxruntime-web/webgpu');
      ort.env.wasm.wasmPaths = `${import.meta.env.BASE_URL}ort/`;
      const bytes = await modelBytes(onProgress);
      const providers = typeof navigator !== 'undefined' && navigator.gpu ? ['webgpu', 'wasm'] : ['wasm'];
      try {
        return { ort, session: await ort.InferenceSession.create(bytes, { executionProviders: providers }) };
      } catch {
        // Alcune schede o driver non reggono WebGPU: il processore va sempre.
        return { ort, session: await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] }) };
      }
    })().catch((e) => {
      sessionPromise = null;
      throw e;
    });
  }
  return sessionPromise;
}

/** Prepara il modello in anticipo (download e avvio), con avanzamento. */
export async function prepareLayoutModel(onProgress) {
  await session(onProgress);
}

/**
 * Zone della pagina: tipo, riquadro (frazioni 0–1), ordine di lettura.
 * @param {HTMLImageElement} img  pagina (già raddrizzata)
 */
export async function detectLayout(img, { onProgress } = {}) {
  const { ort, session: s } = await session(onProgress);
  const S = INPUT_SIZE;
  const canvas = document.createElement('canvas');
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, S, S);
  const rgba = ctx.getImageData(0, 0, S, S).data;
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const out = await s.run({
    image: new ort.Tensor('float32', toInputTensor(rgba), [1, 3, S, S]),
    im_shape: new ort.Tensor('float32', new Float32Array([S, S]), [1, 2]),
    scale_factor: new ort.Tensor('float32', new Float32Array([S / h, S / w]), [1, 2]),
  });
  const names = s.outputNames;
  const boxes = out[names[0]];
  const count = out[names[1]] ? Number(out[names[1]].data[0]) : boxes.dims[0];
  return parseLayoutOutput(boxes.data, Math.min(count, boxes.dims[0]), w, h);
}
