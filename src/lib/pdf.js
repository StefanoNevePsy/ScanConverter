/*
  Rasterizzazione dei PDF in immagini, lato client.

  Nemotron-Parse accetta SOLO immagini: quando l'utente carica un PDF, ogni
  pagina viene renderizzata su canvas ad alta risoluzione e convertita in PNG
  base64, pronta per l'OCR (una chiamata per pagina).
*/

// Build "legacy": include i polyfill necessari e supporta un ventaglio più
// ampio di browser/webview (la build principale usa API JS troppo recenti,
// es. Map#getOrInsertComputed, non ancora disponibili ovunque).
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { isDesktopPdfArtifact } from './desktop.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

// I documenti scansionati incorporano immagini JBIG2/JPEG2000 che pdf.js
// decodifica via WASM. Senza `wasmUrl` la decodifica fallisce in silenzio e la
// pagina risulta bianca. I binari sono in public/pdfjs (serviti a URL fisso).
const WASM_URL = `${import.meta.env.BASE_URL}pdfjs/`;

// Lato lungo target del rendering (px). ~2048px equivale a circa 250 DPI su
// una pagina A4: buona qualità OCR senza payload eccessivi.
const TARGET_LONG_SIDE = 2048;
export const MAX_PDF_PAGES = 20;

/**
 * Copia i byte in un NUOVO buffer prima di passarli a pdf.js: `getDocument`
 * trasferisce (detach) il buffer al worker, rendendolo inutilizzabile. Senza
 * copia, chiamare pdf.js due volte sullo stesso ArrayBuffer (es. estrazione
 * testo poi rendering) dà "Cannot perform Construct on a detached ArrayBuffer".
 */
export function copyBytes(data) {
  return data instanceof Uint8Array ? data.slice() : new Uint8Array(data.slice(0));
}

/**
 * Apre un PDF in pdf.js senza cedere al worker il buffer posseduto dal
 * chiamante. L'anteprima usa il loading task per mantenere una sola pagina
 * canvas alla volta e distruggere esplicitamente le risorse al cambio file.
 *
 * @param {ArrayBuffer|Uint8Array} data
 * @returns {import('pdfjs-dist').PDFDocumentLoadingTask}
 */
export function loadPdfDocument(data) {
  if (isDesktopPdfArtifact(data)) {
    // Il protocollo Electron supporta le richieste Range: pdf.js legge dal
    // file nativo soltanto i blocchi necessari, senza clonare l'intero libro.
    return pdfjsLib.getDocument({ url: data.url, wasmUrl: WASM_URL });
  }
  return pdfjsLib.getDocument({ data: copyBytes(data), wasmUrl: WASM_URL });
}

/**
 * Renderizza le pagine di un PDF in data URL PNG.
 *
 * @param {ArrayBuffer|Uint8Array} data  contenuto del PDF
 * @param {object} [opts]
 * @param {number} [opts.maxPages]       numero massimo di pagine da renderizzare
 * @param {number} [opts.longSide]       lato lungo target in px (default 2048).
 *   Valori più alti = OCR più accurato su scansioni pessime, ma payload e
 *   tempi maggiori.
 * @param {(page:number,total:number)=>void} [opts.onProgress]
 * @returns {Promise<string[]>} data URL PNG, una per pagina
 */
export async function renderPdfToImages(data, opts = {}) {
  const { maxPages = MAX_PDF_PAGES, onProgress } = opts;
  // Limiti prudenti: sotto ~1000px l'OCR degrada, sopra ~5000px i payload
  // rischiano i limiti delle API (Gemini inline_data, NIM).
  const longSide = Math.min(5000, Math.max(1000, opts.longSide || TARGET_LONG_SIDE));
  const loadingTask = loadPdfDocument(data);
  const pdf = await loadingTask.promise;
  try {
    const total = Math.min(pdf.numPages, maxPages);
    const images = [];
    for (let i = 1; i <= total; i++) {
      onProgress?.(i, total);
      const page = await pdf.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const scale = longSide / Math.max(base.width, base.height);
      const viewport = page.getViewport({ scale });

      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d', { alpha: false });
      // Sfondo bianco: le vecchie scansioni spesso hanno trasparenza/aloni.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      await page.render({ canvasContext: ctx, viewport }).promise;
      images.push(canvas.toDataURL('image/png'));
      page.cleanup();
    }
    return images;
  } finally {
    // In pdfjs v6 le risorse si liberano dal loading task, non dal documento.
    loadingTask.destroy();
  }
}

/**
 * Conta le pagine di un PDF senza renderizzarle.
 * @param {ArrayBuffer|Uint8Array} data
 * @returns {Promise<number>}
 */
export async function countPdfPages(data) {
  const loadingTask = loadPdfDocument(data);
  const pdf = await loadingTask.promise;
  const n = pdf.numPages;
  loadingTask.destroy();
  return n;
}
