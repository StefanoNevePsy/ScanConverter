/*
  Ricostruzione del documento a partire dai blocchi di Nemotron-Parse
  (markdown_bbox): ordina i blocchi in ordine di lettura, preserva i livelli
  di titolo (## / ### / ####) e inserisce segnaposti per le figure, che
  vengono ritagliate dalla pagina sorgente e incorporate nel Typst.
*/

import { loadImage, cropToPng } from './figures.js';

const PICTURE_TYPES = new Set(['Picture', 'Figure', 'Image']);
const CAPTION_TYPES = new Set(['Caption']);
const FOOTNOTE_TYPES = new Set(['Footnote', 'Footnote-text', 'FootnoteText']);
// Arredo di pagina della scansione (testatine, numeri di pagina): non è
// contenuto e sporca sia il prompt sia la verifica di fedeltà. Le vere note
// a piè di pagina (Footnote) invece SONO contenuto e restano.
const FURNITURE_TYPES = new Set(['Page-header', 'Page-footer']);
const HEADING_LEVELS = new Map([
  ['Title', 1],
  ['Document-title', 1],
  ['Section-header', 2],
  ['Heading', 2],
  ['Subsection-header', 3],
  ['Subheading', 3],
]);
const ARABIC_PAGE_NUMBER_RE = /^(?:pagina\s+)?\d{1,3}$/i;
const ROMAN_PAGE_NUMBER_RE = /^(?:PAGINA\s+)?[IVXLCDM]{1,10}$/;
const isPageNumberText = (text) =>
  ARABIC_PAGE_NUMBER_RE.test(text) || ROMAN_PAGE_NUMBER_RE.test(text);

function isFootnoteBlock(b) {
  if (FOOTNOTE_TYPES.has(b?.type)) return true;
  if (b?.type !== 'Text' || !b?.bbox || (b.bbox.ymin ?? 0) < 0.7) return false;
  const text = String(b.text || '').trim();
  return /^(?:[*†‡]\s+|[—–-]\s*(?:trad\.|traduzione\b))/iu.test(text);
}

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
  if (!b?.bbox) return false;
  const text = (b.text || '').trim();
  if (isFootnoteBlock(b)) return false;
  // I numeri di pagina sono spesso classificati semplicemente come Text e
  // collocati ben sopra il bordo fisico (ampio margine bianco): per loro usa
  // una fascia più larga e non dipendere dal tipo restituito dal modello.
  if (isPageNumberText(text)) {
    const nearNumberTop = (b.bbox.ymax ?? 1) < 0.22;
    const nearNumberBottom = (b.bbox.ymin ?? 0) > 0.80;
    if (nearNumberTop || nearNumberBottom) return true;
  }
  if (b.type !== 'Text') return false;
  if (text.length > 90) return false;
  const nearTop = (b.bbox.ymax ?? 1) < 0.09;
  const nearBottom = (b.bbox.ymin ?? 0) > 0.93;
  return nearTop || nearBottom;
}

function looksLikeRunningHeader(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  const words = t.match(/[\p{L}\p{N}]+/gu) || [];
  return t.length >= 4 && t.length <= 110 && words.length >= 2 && words.length <= 12 && !/[,.!?;:]/u.test(t);
}

/**
 * Arredo contestuale: una breve riga Text nella fascia alta viene scartata
 * solo se sulla stessa pagina c'è anche un numero di pagina in alto. I veri
 * Title/Section-header restano contenuto, anche se occupano la stessa zona.
 */
export function pageFurnitureBlocks(blocks) {
  const furniture = new Set((blocks || []).filter(isPageFurniture));
  const topNumbers = (blocks || []).filter((b) =>
    b?.bbox && isPageNumberText((b.text || '').trim()) && (b.bbox.ymax ?? 1) < 0.22);
  if (!topNumbers.length) return furniture;
  for (const b of blocks || []) {
    if (
      b?.type === 'Text' &&
      b.bbox &&
      (b.bbox.ymax ?? 1) < 0.22 &&
      (b.bbox.ymax ?? 0) - (b.bbox.ymin ?? 0) < 0.07 &&
      looksLikeRunningHeader(b.text)
    ) {
      furniture.add(b);
    }
  }
  return furniture;
}

/** Converte i tipi strutturati dell'OCR in livelli Markdown espliciti. */
export function headingMarkdown(b) {
  const text = String(b?.text || '').trim();
  if (!text || /^#{1,6}\s/.test(text)) return text;
  let level = HEADING_LEVELS.get(b?.type);
  if (!level) return text;
  const numbered = text.match(/^\s*\d+(?:\.(\d+)){0,4}[.)]?\s+/);
  if (numbered) {
    const prefix = numbered[0].trim().replace(/[.)]$/, '');
    level = Math.min(6, prefix.split('.').filter(Boolean).length);
  }
  return `${'#'.repeat(level)} ${text}`;
}

/** Marcatura semantica privata, poi convertita localmente in #footnote[…]. */
export function footnoteMarkdown(text) {
  const note = String(text || '')
    .trim()
    // L'asterisco è normalmente il richiamo grafico, non parte della nota.
    .replace(/^\s*[*†‡]\s*/, '')
    .replace(/\s*\n\s*/g, ' ');
  return note ? `<footnote>${note}</footnote>` : '';
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
 * ORDINE DI LETTURA per XY-cut ricorsivo (standard dell'analisi layout):
 * si cerca un "taglio" verticale che nessun blocco attraversa (il canale tra
 * due colonne, o la piega di una doppia pagina) → prima tutto il lato
 * sinistro, poi il destro; altrimenti un taglio orizzontale (bande
 * alto→basso); altrimenti si emette in ordine (y, x). Un titolo a tutta
 * larghezza impedisce il taglio verticale al suo livello, quindi separa
 * correttamente "sopra" e "sotto" prima delle colonne. Sulla colonna singola
 * non esistono tagli verticali validi → identico al semplice alto→basso.
 * @param {Array} blocks blocchi con bbox normalizzata
 * @returns {Array} blocchi in ordine di lettura
 */
export function orderBlocks(blocks) {
  const boxed = blocks.filter((b) => b?.bbox);
  const unboxed = blocks.filter((b) => !b?.bbox);
  const out = [];
  xyCut(boxed, out, 0);
  return [...out, ...unboxed];
}

function xyCut(items, out, depth) {
  if (items.length <= 1 || depth > 12) {
    emitByPosition(items, out);
    return;
  }
  // Taglio VERTICALE (colonne/piega): decide l'ordine di lettura.
  const xCut = widestGap(items, 'xmin', 'xmax', 0.015);
  if (xCut != null) {
    const left = items.filter((b) => (b.bbox.xmin + b.bbox.xmax) / 2 < xCut);
    const right = items.filter((b) => (b.bbox.xmin + b.bbox.xmax) / 2 >= xCut);
    if (left.length && right.length) {
      xyCut(left, out, depth + 1);
      xyCut(right, out, depth + 1);
      return;
    }
  }
  // Nessun taglio verticale: se a impedirlo sono blocchi a tutta larghezza
  // (titolo, figura panoramica) sopra/sotto/fra colonne, trattali come
  // SEPARATORI orizzontali: le colonne si ordinano DENTRO ciascuna banda.
  // (Il taglio orizzontale "più largo" qui sarebbe sbagliato: può cadere fra
  // le righe allineate delle due colonne e alternarle riga per riga.)
  const narrow = items.filter((b) => b.bbox.xmax - b.bbox.xmin < 0.55);
  const wide = items.filter((b) => b.bbox.xmax - b.bbox.xmin >= 0.55);
  if (wide.length && narrow.length >= 2 && widestGap(narrow, 'xmin', 'xmax', 0.015) != null) {
    const spanners = [...wide].sort((a, b) => a.bbox.ymin - b.bbox.ymin);
    const regions = Array.from({ length: spanners.length + 1 }, () => []);
    for (const b of narrow) {
      const cy = (b.bbox.ymin + b.bbox.ymax) / 2;
      let k = 0;
      while (k < spanners.length && cy > (spanners[k].bbox.ymin + spanners[k].bbox.ymax) / 2) k++;
      regions[k].push(b);
    }
    regions.forEach((region, k) => {
      if (region.length) xyCut(region, out, depth + 1);
      if (k < spanners.length) out.push(spanners[k]);
    });
    return;
  }
  emitByPosition(items, out);
}

/** Centro del varco più largo (≥ minGap) che nessun intervallo attraversa. */
function widestGap(items, lo, hi, minGap) {
  const iv = items
    .map((b) => [b.bbox[lo] ?? 0, b.bbox[hi] ?? 0])
    .sort((a, b) => a[0] - b[0]);
  let end = iv[0][1];
  let best = null;
  let bestW = minGap;
  for (let i = 1; i < iv.length; i++) {
    const gap = iv[i][0] - end;
    if (gap >= bestW) {
      bestW = gap;
      best = end + gap / 2;
    }
    end = Math.max(end, iv[i][1]);
  }
  return best;
}

function emitByPosition(items, out) {
  out.push(
    ...[...items].sort(
      (a, b) => (a.bbox?.ymin ?? 0) - (b.bbox?.ymin ?? 0) || (a.bbox?.xmin ?? 0) - (b.bbox?.xmin ?? 0),
    ),
  );
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
  // L'arredo di pagina esce subito; il resto va in ordine di lettura XY-cut
  // (colonne e doppie pagine lette nel verso giusto).
  const furniture = pageFurnitureBlocks(blocks);
  const sorted = orderBlocks(blocks.filter((b) => !furniture.has(b)));
  const captions = sorted.filter((b) => CAPTION_TYPES.has(b.type));
  const hasPictures = sorted.some((b) => PICTURE_TYPES.has(b.type) && b.bbox);
  const img = hasPictures ? await loadImage(pageDataUrl) : null;

  const figures = [];
  const lines = [];
  const pendingFootnotes = [];
  let lastProseIndex = -1;

  for (const b of sorted) {
    if (furniture.has(b)) continue; // testatine/numeri di pagina
    if (isFootnoteBlock(b)) {
      const note = footnoteMarkdown(b.text);
      if (note) {
        // «— Trad. inglese …» è spesso un secondo blocco OCR della stessa
        // nota con asterisco, non una nuova nota autonoma.
        if (/^<footnote>[—–-]\s*(?:trad\.|traduzione\b)/iu.test(note) && pendingFootnotes.length) {
          pendingFootnotes[pendingFootnotes.length - 1] =
            pendingFootnotes[pendingFootnotes.length - 1].replace(
              /<\/footnote>$/i,
              ` ${note.slice('<footnote>'.length)}`,
            );
        } else {
          pendingFootnotes.push(note);
        }
      }
    } else if (PICTURE_TYPES.has(b.type) && b.bbox && img) {
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
      lines.push(normalizeDialogue(headingMarkdown(b)));
      if (!HEADING_LEVELS.has(b.type)) lastProseIndex = lines.length - 1;
    }
  }

  // Le note fisicamente in fondo pagina non sono paragrafi nel flusso:
  // agganciale all'ultimo passaggio di prosa, così Typst colloca richiamo e
  // testo a piè pagina senza interrompere il capitolo successivo.
  if (pendingFootnotes.length) {
    const notes = pendingFootnotes.join(' ');
    if (lastProseIndex >= 0) lines[lastProseIndex] += ` ${notes}`;
    else lines.push(notes);
  }

  return { markdown: lines.join('\n\n'), figures };
}

/**
 * Contatore progressivo delle figure. `start` consente di riprendere la
 * numerazione dopo un OCR interrotto (le figure già estratte hanno indici
 * 1..start). `count` espone il valore corrente da persistere.
 */
export function makeFigureCounter(start = 0) {
  let n = start;
  return { next: () => ++n, count: () => n };
}
