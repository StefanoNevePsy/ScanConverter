/*
  OCR guidato dall'impaginazione: PP-DocLayoutV3 (nell'app) + un lettore
  (PaddleOCR-VL su Ollama, o un altro modello di visione).

  Ordine, e perché:
  1. ZONE. Il modello di impaginazione trova titoli, paragrafi, voci
     d'elenco, figure, didascalie, note, testatine — con riquadro e ordine
     di lettura. Lavora sulla pagina già raddrizzata, quindi i riquadri
     coincidono con quello che si ritaglia.
  2. SCARTO. Testatine e numeri di pagina non si leggono nemmeno: tempo
     risparmiato e niente testatine da togliere dopo.
  3. LETTURA PER ZONA. Ogni zona è ritagliata e letta da sola, con il
     compito adatto (testo, tabella, formula). Un titolo letto da solo non
     può fondersi con il paragrafo sotto, e il lettore non deve indovinare
     cosa sta leggendo: lo sa la pipeline.
  4. BLOCCHI. Tipo + riquadro + testo + ordine, nella stessa forma di
     Nemotron-Parse: tutto quello che viene dopo (dimensione relativa dei
     titoli, gerarchia, figure ritagliate, didascalie, note) funziona
     senza modifiche.
*/

import { loadImage, cropToDataUrl } from './figures.js';
import { detectLayout } from './layoutModel.js';
import { joinRegionLines, planRegion } from './layoutRegions.js';
import { ollamaRecognize } from './ollamaOcr.js';
import { htmlTableToMarkdown } from './paddle.js';

// «R. Castaldo, S. Bari, G. Tocchi» — elenco di autori, non un titolo, anche
// se il modello lo vede come parte del titolo del capitolo.
const AUTHORS_RE = /^(?:[\p{Lu}]\.\s?)+[\p{Lu}][\p{L}'’-]+(?:\s*,\s*(?:[\p{Lu}]\.\s?)+[\p{Lu}][\p{L}'’-]+)+\.?$/u;
const NUMERAL_RE = /^\s*(?:\d{1,3}|[IVXLC]{1,6})\s*$/;

/**
 * Esegue i lavori con al massimo `limit` in parallelo, mantenendo l'ordine.
 */
async function mapLimited(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Testo letto → blocco della pipeline (o null se la zona va scartata). */
export function regionToBlock(region, plan, text) {
  const base = { bbox: region.bbox, order: region.order };
  if (plan.action === 'keep') return { ...base, type: 'Picture', text: '' };
  if (plan.action === 'probe') {
    // Immagine piccola: conta come testo solo se contiene un numero (il «3»
    // nel cerchio dell'apertura di capitolo). Altrimenti è un ornamento.
    return NUMERAL_RE.test(text || '')
      ? { ...base, type: 'Text', text: text.trim() }
      : { ...base, type: 'Picture', text: '' };
  }
  let body = plan.type === 'Table' ? htmlTableToMarkdown(text) : joinRegionLines(text, plan.type);
  if (!body) return null;
  let { type } = plan;
  if ((type === 'Title' || type === 'Section-header') && AUTHORS_RE.test(body)) type = 'Text';
  if (type === 'Formula' && !/^\$/.test(body)) body = `$$${body}$$`;
  return { ...base, type, text: body };
}

/**
 * @param {object} p
 * @param {string} p.imageDataUrl  pagina già raddrizzata
 * @param {string} [p.endpoint]    Ollama (chat/completions)
 * @param {string} [p.model]       lettore su Ollama
 * @param {(msg:string)=>void} [p.onDetail]
 * @param {AbortSignal} [p.signal]
 * @returns {Promise<Array<{type:string,bbox:object,text:string,order:number}>>}
 */
export async function layoutOcrBlocks({ imageDataUrl, endpoint, model, onDetail, signal }) {
  const img = await loadImage(imageDataUrl);
  onDetail?.('analisi dell’impaginazione…');
  const regions = await detectLayout(img, {
    onProgress: (pct) => onDetail?.(`scarico il modello di impaginazione (una volta sola): ${pct}%`),
  });
  const work = regions.map((region) => ({ region, plan: planRegion(region) })).filter((w) => w.plan.action !== 'skip');
  let done = 0;
  const toRead = work.filter((w) => w.plan.action !== 'keep').length;
  // Due letture alla volta: Ollama serve una richiesta per volta per modello
  // di default, la seconda prepara il ritaglio mentre la prima è in corso.
  const blocks = await mapLimited(work, 2, async ({ region, plan }) => {
    if (signal?.aborted) throw new DOMException('Annullato', 'AbortError');
    if (plan.action === 'keep') return regionToBlock(region, plan, '');
    const crop = cropToDataUrl(img, region.bbox, 0.006);
    const text = await ollamaRecognize({
      endpoint,
      model,
      imageDataUrl: crop,
      task: plan.action === 'probe' ? 'text' : plan.task,
      signal,
    });
    done++;
    onDetail?.(`lettura delle zone ${done}/${toRead}…`);
    return regionToBlock(region, plan, text);
  });
  return blocks.filter(Boolean);
}
