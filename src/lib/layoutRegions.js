/*
  Analisi dell'impaginazione con PP-DocLayoutV3 — la parte che non dipende
  dal motore di calcolo: lettura dell'uscita del modello, pulizia delle zone,
  traduzione nei tipi della pipeline, scelta di cosa far leggere all'OCR.

  Perché un modello di impaginazione separato dall'OCR: il lettore (es.
  PaddleOCR-VL su Ollama) trascrive bene ma non sa cosa sta leggendo. Qui
  ogni zona arriva all'OCR già classificata — titolo, paragrafo, didascalia,
  nota — e ritagliata: un titolo letto da solo non si fonde col paragrafo
  sotto, e la sua posizione e dimensione restano note per la gerarchia.
*/

/** Etichette del modello, nell'ordine dei suoi indici (inference.yml ufficiale). */
export const LAYOUT_LABELS = [
  'abstract', 'algorithm', 'aside_text', 'chart', 'content', 'display_formula',
  'doc_title', 'figure_title', 'footer', 'footer_image', 'footnote', 'formula_number',
  'header', 'header_image', 'image', 'inline_formula', 'number', 'paragraph_title',
  'reference', 'reference_content', 'seal', 'table', 'text', 'vertical_text', 'vision_footnote',
];

/** Etichetta del modello → tipo della pipeline (quelli di Nemotron-Parse). */
const TYPE_OF = {
  doc_title: 'Title',
  paragraph_title: 'Section-header',
  text: 'Text',
  abstract: 'Text',
  content: 'Text',
  aside_text: 'Text',
  vertical_text: 'Text',
  algorithm: 'Text',
  reference: 'Text',
  reference_content: 'Text',
  figure_title: 'Caption',
  footnote: 'Footnote',
  vision_footnote: 'Footnote',
  table: 'Table',
  display_formula: 'Formula',
  image: 'Picture',
  chart: 'Picture',
  seal: 'Picture',
  header_image: 'Picture',
  footer_image: 'Picture',
  header: 'Page-header',
  footer: 'Page-footer',
  number: 'Page-footer',
};

/** Zone che non si leggono: arredo di pagina, formule dentro il testo. */
const SKIP = new Set(['header', 'footer', 'number', 'inline_formula', 'formula_number']);

export const INPUT_SIZE = 800;

/**
 * Prepara il tensore d'ingresso: pagina stirata a 800×800 (come in
 * addestramento, senza mantenere le proporzioni), RGB in CHW, valori 0–1.
 * @param {Uint8ClampedArray} rgba  pixel della pagina già ridotta a 800×800
 */
export function toInputTensor(rgba) {
  const S = INPUT_SIZE;
  const out = new Float32Array(3 * S * S);
  for (let i = 0, p = 0; i < S * S; i++, p += 4) {
    out[i] = rgba[p] / 255;
    out[S * S + i] = rgba[p + 1] / 255;
    out[2 * S * S + i] = rgba[p + 2] / 255;
  }
  return out;
}

const iou = (a, b) => {
  const x0 = Math.max(a.xmin, b.xmin);
  const y0 = Math.max(a.ymin, b.ymin);
  const x1 = Math.min(a.xmax, b.xmax);
  const y1 = Math.min(a.ymax, b.ymax);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const area = (r) => (r.xmax - r.xmin) * (r.ymax - r.ymin);
  return inter / (area(a) + area(b) - inter || 1);
};

/**
 * Uscita grezza del modello → zone pulite e ordinate.
 *
 * - soglia bassa (0,35): sulle aperture di capitolo «CAPITOLO» e gli autori
 *   escono con sicurezza 0,45–0,48 e una soglia standard li perderebbe;
 * - la stessa zona proposta con due etichette (es. text 0,48 / header 0,29)
 *   resta una volta sola, con l'etichetta più sicura;
 * - coordinate in frazioni della pagina, ordine di lettura del modello.
 *
 * @param {Float32Array|number[]} data   righe [classe, punteggio, x1, y1, x2, y2, ordine]
 * @param {number} rows
 * @param {number} width   larghezza della pagina in pixel (coordinate del modello)
 * @param {number} height
 */
export function parseLayoutOutput(data, rows, width, height, threshold = 0.35) {
  const regions = [];
  for (let r = 0; r < rows; r++) {
    const o = r * 7;
    const score = Number(data[o + 1]);
    if (!(score >= threshold)) continue;
    const label = LAYOUT_LABELS[Math.round(Number(data[o]))];
    if (!label) continue;
    const clamp = (v) => Math.min(1, Math.max(0, v));
    const box = {
      xmin: clamp(Number(data[o + 2]) / width),
      ymin: clamp(Number(data[o + 3]) / height),
      xmax: clamp(Number(data[o + 4]) / width),
      ymax: clamp(Number(data[o + 5]) / height),
    };
    if (box.xmax - box.xmin < 0.005 || box.ymax - box.ymin < 0.003) continue;
    regions.push({ label, score, bbox: box, order: Number(data[o + 6]) });
  }
  regions.sort((a, b) => b.score - a.score);
  const kept = [];
  for (const r of regions) {
    if (kept.some((k) => iou(k.bbox, r.bbox) > 0.7)) continue;
    kept.push(r);
  }
  return kept.sort((a, b) => a.order - b.order);
}

/**
 * Cosa fare di ogni zona.
 * - 'read'  → ritagliare e far leggere all'OCR con il compito indicato;
 * - 'probe' → immagine piccola: si fa leggere, e se contiene un numero o una
 *             parola breve diventa testo (il «3» nel cerchio dell'apertura
 *             di capitolo), altrimenti resta figura;
 * - 'keep'  → figura: si conserva la geometria, niente testo;
 * - 'skip'  → arredo di pagina: non si legge nemmeno.
 */
export function planRegion(region) {
  const type = TYPE_OF[region.label] || 'Text';
  if (SKIP.has(region.label)) return { type, action: 'skip' };
  if (type === 'Picture') {
    const { bbox } = region;
    const area = (bbox.xmax - bbox.xmin) * (bbox.ymax - bbox.ymin);
    return { type, action: area < 0.03 ? 'probe' : 'keep' };
  }
  const task = type === 'Table' ? 'table' : type === 'Formula' ? 'formula' : 'text';
  return { type, action: 'read', task };
}

/**
 * Testo letto da una zona → testo del blocco: righe unite, sillabazione a
 * fine riga sciolta, spazi normalizzati. Gli elenchi restano su righe
 * separate (ogni voce è un'unità).
 */
export function joinRegionLines(text, type) {
  const lines = String(text || '').replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (type === 'Table') return lines.join('\n');
  const out = [];
  for (const line of lines) {
    const listItem = /^(?:[-–•·*]\s+|\d{1,3}[.)]\s+|\\\(\\bullet\\\))/.test(line);
    const prev = out[out.length - 1];
    if (!prev || listItem) out.push(line);
    else if (/[\p{L}]-$/u.test(prev) && /^[\p{Ll}]/u.test(line)) out[out.length - 1] = prev.slice(0, -1) + line;
    else out[out.length - 1] = `${prev} ${line}`;
  }
  return out.join('\n').replace(/[ \t]{2,}/g, ' ').trim();
}

/** Ritaglio con un po' di margine: le lettere ai bordi non vanno tagliate. */
export function paddedBox(bbox, pad = 0.006) {
  return {
    xmin: Math.max(0, bbox.xmin - pad),
    ymin: Math.max(0, bbox.ymin - pad),
    xmax: Math.min(1, bbox.xmax + pad),
    ymax: Math.min(1, bbox.ymax + pad),
  };
}
