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

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

// Lato lungo target del rendering (px). ~2048px equivale a circa 250 DPI su
// una pagina A4: buona qualità OCR senza payload eccessivi.
const TARGET_LONG_SIDE = 2048;
export const MAX_PDF_PAGES = 20;

/**
 * Renderizza le pagine di un PDF in data URL PNG.
 *
 * @param {ArrayBuffer|Uint8Array} data  contenuto del PDF
 * @param {object} [opts]
 * @param {number} [opts.maxPages]       numero massimo di pagine da renderizzare
 * @param {(page:number,total:number)=>void} [opts.onProgress]
 * @returns {Promise<string[]>} data URL PNG, una per pagina
 */
export async function renderPdfToImages(data, opts = {}) {
  const { maxPages = MAX_PDF_PAGES, onProgress } = opts;
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);

  const loadingTask = pdfjsLib.getDocument({ data: bytes });
  const pdf = await loadingTask.promise;
  try {
    const total = Math.min(pdf.numPages, maxPages);
    const images = [];
    for (let i = 1; i <= total; i++) {
      onProgress?.(i, total);
      const page = await pdf.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const scale = TARGET_LONG_SIDE / Math.max(base.width, base.height);
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
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const loadingTask = pdfjsLib.getDocument({ data: bytes });
  const pdf = await loadingTask.promise;
  const n = pdf.numPages;
  loadingTask.destroy();
  return n;
}
