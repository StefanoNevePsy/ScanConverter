/*
  Ricostruzione del documento a partire dai blocchi di Nemotron-Parse
  (markdown_bbox): ordina i blocchi in ordine di lettura, preserva i livelli
  di titolo (## / ### / ####) e inserisce segnaposti per le figure, che
  vengono ritagliate dalla pagina sorgente e incorporate nel Typst.
*/

import { loadImage, cropToPng } from './figures.js';

const PICTURE_TYPES = new Set(['Picture', 'Figure', 'Image']);
const CAPTION_TYPES = new Set(['Caption']);
// Arredo di pagina della scansione (testatine, numeri di pagina): non è
// contenuto e sporca sia il prompt sia la verifica di fedeltà. Le vere note
// a piè di pagina (Footnote) invece SONO contenuto e restano.
const FURNITURE_TYPES = new Set(['Page-header', 'Page-footer']);

const cy = (b) => ((b.bbox?.ymin ?? 0) + (b.bbox?.ymax ?? 0)) / 2;

/**
 * Larghezza Typst della figura derivata dal bbox: la frazione di pagina
 * occupata nell'originale, rapportata alla gabbia del testo (~72% della
 * pagina scansionata, margini esclusi). Così un ritaglio piccolo resta
 * piccolo e una figura a piena pagina occupa tutta la colonna.
 */
export function widthPctFromBbox(bbox) {
  const w = Math.max(0, (bbox?.xmax ?? 0) - (bbox?.xmin ?? 0));
  if (!w) return 60; // bbox assente: default prudente
  return Math.round(Math.min(100, Math.max(15, (w / 0.72) * 100)));
}

/**
 * Euristica per gli artefatti di scansione classificati "Picture" dall'OCR:
 * ritagli minuscoli o strisce sottili (numeri di pagina scritti a mano,
 * timbri, righe). Non vengono scartati, ma proposti come "da rimuovere"
 * nella revisione figure.
 */
export function isLikelyArtifact(bbox) {
  if (!bbox) return false;
  const w = Math.max(0, (bbox.xmax ?? 0) - (bbox.xmin ?? 0));
  const h = Math.max(0, (bbox.ymax ?? 0) - (bbox.ymin ?? 0));
  return w * h < 0.02 || w < 0.08 || h < 0.05;
}

// Parlante di un dialogo: nome in MAIUSCOLO (1–4 parole, eventuale nota tra
// parentesi) seguito da due punti. Es. «TERAPISTA (rivolto a Sissi):».
const SPEAKER = String.raw`[A-ZÀ-ÖØ-Þ][A-ZÀ-ÖØ-Þ'’.\-]+(?:\s+[A-ZÀ-ÖØ-Þ'’.\-]{2,}){0,3}(?:\s*\([^)\n]{0,100}\))?\s*:`;
const SPEAKER_LINE_RE = new RegExp(`^[ \\t]{0,3}(?:\\*\\*|__)?${SPEAKER}`);
const SPEAKER_MIDLINE_RE = new RegExp(`([.!?…»”\\)\\]])[ \\t]+(?=${SPEAKER})`, 'g');

/**
 * Riconosce l'arredo di pagina: o il tipo dichiarato dall'OCR, oppure —
 * quando l'OCR lo classifica come Text — un blocco CORTO attaccato al bordo
 * alto/basso della pagina (testatina con autori, numero di pagina). I veri
 * paragrafi ai bordi sono lunghi; le note (Footnote) e i titoli
 * (Section-header/Title) non vengono mai toccati.
 */
export function isPageFurniture(b) {
  if (FURNITURE_TYPES.has(b?.type)) return true;
  if (b?.type !== 'Text' || !b.bbox) return false;
  const text = (b.text || '').trim();
  if (text.length > 90) return false;
  const nearTop = (b.bbox.ymax ?? 1) < 0.09;
  const nearBottom = (b.bbox.ymin ?? 0) > 0.93;
  return nearTop || nearBottom;
}

/**
 * Normalizza i dialoghi trascritti dall'OCR: ogni battuta introdotta dal nome
 * del parlante in maiuscolo («TERAPISTA: …», «FIGLIO: …») diventa un
 * paragrafo a sé. Senza questo, il Markdown tratta gli a-capo singoli come
 * spazi e l'LLM fonde le battute in un unico paragrafo.
 */
export function normalizeDialogue(text) {
  // Battute incollate sulla stessa riga → a capo prima del nuovo parlante.
  let t = text.replace(SPEAKER_MIDLINE_RE, '$1\n');
  const out = [];
  for (const line of t.split('\n')) {
    if (SPEAKER_LINE_RE.test(line) && out.length && out[out.length - 1].trim() !== '') {
      out.push(''); // riga vuota = nuovo paragrafo in Markdown
    }
    out.push(line);
  }
  return out.join('\n');
}

/**
 * Impone alle immagini del codice Typst generato la larghezza derivata dal
 * bbox (deterministico, ignora l'eventuale width inventata dall'LLM).
 * @param {string} code
 * @param {{path:string,widthPct?:number}[]} figures
 */
export function applyFigureWidths(code, figures) {
  let s = code;
  for (const f of figures || []) {
    if (!f?.path || !f?.widthPct) continue;
    const escaped = f.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(
      `image\\(\\s*"${escaped}"\\s*(?:,\\s*width:\\s*[\\d.]+%)?`,
      'g',
    );
    s = s.replace(re, `image("${f.path}", width: ${f.widthPct}%`);
  }
  return s;
}

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
    if (isPageFurniture(b)) continue; // testatine/numeri di pagina
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
      figures.push({
        path,
        bytes,
        widthPct: widthPctFromBbox(b.bbox),
        junk: isLikelyArtifact(b.bbox),
      });
      // Segnaposto Markdown che l'LLM convertirà in #figure(image(...)).
      lines.push(`![${caption}](${path})`);
    } else if (CAPTION_TYPES.has(b.type)) {
      if (!b._used && b.text) lines.push(b.text);
    } else if (b.text) {
      lines.push(normalizeDialogue(b.text));
    }
  }

  return { markdown: lines.join('\n\n'), figures };
}

export function makeFigureCounter() {
  let n = 0;
  return { next: () => ++n };
}
