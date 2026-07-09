/*
  Ricostruzione del documento a partire dai blocchi di Nemotron-Parse
  (markdown_bbox): ordina i blocchi in ordine di lettura, preserva i livelli
  di titolo (## / ### / ####) e inserisce segnaposti per le figure, che
  vengono ritagliate dalla pagina sorgente e incorporate nel Typst.
*/

import { loadImage, cropToPng } from './figures.js';

const PICTURE_TYPES = new Set(['Picture', 'Figure', 'Image']);
const CAPTION_TYPES = new Set(['Caption']);

const cy = (b) => ((b.bbox?.ymin ?? 0) + (b.bbox?.ymax ?? 0)) / 2;

/** Trova la didascalia più vicina (in verticale) a una figura. */
function nearestCaption(captions, picture) {
  let best = null;
  let bestDist = Infinity;
  for (const c of captions) {
    if (c._used) continue;
    const d = Math.abs(cy(c) - cy(picture));
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  // Considera la didascalia associata solo se ragionevolmente vicina.
  return best && bestDist < 0.12 ? best : null;
}

/**
 * Ricostruisce una pagina: markdown (con segnaposti immagine) + figure
 * ritagliate. `figureCounter.next()` fornisce indici progressivi globali.
 *
 * @param {Array} blocks blocchi Nemotron (type, bbox, text)
 * @param {string} pageDataUrl data URL della pagina sorgente
 * @param {{next:()=>number}} figureCounter
 * @returns {Promise<{markdown:string, figures:{path:string,bytes:Uint8Array}[]}>}
 */
export async function assemblePage(blocks, pageDataUrl, figureCounter) {
  const sorted = [...blocks].sort(
    (a, b) => (a.bbox?.ymin ?? 0) - (b.bbox?.ymin ?? 0) || (a.bbox?.xmin ?? 0) - (b.bbox?.xmin ?? 0),
  );
  const captions = sorted.filter((b) => CAPTION_TYPES.has(b.type));
  const hasPictures = sorted.some((b) => PICTURE_TYPES.has(b.type) && b.bbox);
  const img = hasPictures ? await loadImage(pageDataUrl) : null;

  const figures = [];
  const lines = [];

  for (const b of sorted) {
    if (PICTURE_TYPES.has(b.type) && b.bbox && img) {
      const n = figureCounter.next();
      const path = `/figures/fig-${n}.png`;
      let bytes;
      try {
        bytes = cropToPng(img, b.bbox);
      } catch {
        continue; // ritaglio fallito: salta la figura, non bloccare il testo
      }
      const cap = nearestCaption(captions, b);
      if (cap) cap._used = true;
      const caption = (cap?.text || '').replace(/[[\]]/g, '');
      figures.push({ path, bytes });
      // Segnaposto Markdown che Gemini convertirà in #figure(image(...)).
      lines.push(`![${caption || `Figura ${n}`}](${path})`);
    } else if (CAPTION_TYPES.has(b.type)) {
      if (!b._used && b.text) lines.push(b.text);
    } else if (b.text) {
      lines.push(b.text);
    }
  }

  return { markdown: lines.join('\n\n'), figures };
}

export function makeFigureCounter() {
  let n = 0;
  return { next: () => ++n };
}
