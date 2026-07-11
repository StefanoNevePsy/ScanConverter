/*
  Estrazione del TESTO da PDF che hanno già un layer testuale (vettoriali o
  già passati per un OCR come Acrobat/ocrmypdf). In questi casi il testo è
  esatto — nessun errore di lettura — e si può saltare del tutto la fase OCR
  con NVIDIA.

  Limite onesto rispetto a Nemotron-Parse: qui non si estraggono figure né
  tabelle (non fanno parte del layer testo); la gerarchia dei titoli è
  euristica, dedotta dalla dimensione del font. Per re-impaginare e correggere
  un testo già digitale è però la via più fedele.

  Ritorna `null` se il PDF non ha testo utile (pura scansione): il chiamante
  ricade allora sull'OCR.
*/

import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { copyBytes } from './pdf.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
const WASM_URL = `${import.meta.env.BASE_URL}pdfjs/`;

/** Dimensione font di un item (dal transform o dall'altezza). */
function fontSize(item) {
  const t = item.transform || [];
  const s = Math.hypot(t[2] || 0, t[3] || 0);
  return s || item.height || 0;
}

/** Raggruppa gli item di una pagina in righe (per coordinata y). */
function groupLines(items) {
  const rows = [];
  for (const it of items) {
    const str = it.str ?? '';
    if (!str) continue;
    const y = Math.round((it.transform?.[5] ?? 0) * 10) / 10;
    const x = it.transform?.[4] ?? 0;
    let row = rows.find((r) => Math.abs(r.y - y) < 3);
    if (!row) {
      row = { y, items: [] };
      rows.push(row);
    }
    row.items.push({ x, str, size: fontSize(it) });
  }
  // Dall'alto in basso (in PDF y cresce verso l'alto), sinistra→destra.
  rows.sort((a, b) => b.y - a.y);
  return rows.map((r) => {
    r.items.sort((a, b) => a.x - b.x);
    return {
      y: r.y,
      text: r.items.map((i) => i.str).join('').replace(/\s+/g, ' ').trim(),
      size: Math.max(...r.items.map((i) => i.size)),
    };
  });
}

/**
 * Costruisce la mappa dimensione→livello per rango: le dimensioni dei titoli
 * (nettamente maggiori del corpo) sono ordinate dalla più grande alla più
 * piccola e mappate a livelli 1..4 in quell'ordine. Così due dimensioni
 * distinte restano SEMPRE su livelli distinti e ordinati (nessun accorpamento
 * arbitrario), più robusto delle soglie fisse.
 * @param {number[]} sizes dimensioni (arrotondate) di tutte le righe di testo
 * @param {number} body dimensione del corpo
 * @returns {Map<number, number>} dimensione → livello (1..4)
 */
function buildLevelMap(sizes, body) {
  const headingSizes = [...new Set(sizes)]
    .filter((s) => s >= body * 1.12)
    .sort((a, b) => b - a);
  const map = new Map();
  headingSizes.forEach((s, i) => map.set(s, Math.min(i + 1, 4)));
  return map;
}

/**
 * Estrae il testo (Markdown con titoli euristici) da un PDF con layer testo.
 * @param {ArrayBuffer|Uint8Array} data
 * @param {object} [opts]
 * @param {number} [opts.maxPages]
 * @param {(page:number,total:number)=>void} [opts.onProgress]
 * @returns {Promise<string|null>} Markdown, o null se non c'è testo utile
 */
export async function extractPdfText(data, opts = {}) {
  const { maxPages = 2000, onProgress } = opts;
  // Copia: pdf.js detacha il buffer passato: senza copia la successiva
  // rasterizzazione sullo stesso buffer fallirebbe (detached ArrayBuffer).
  const bytes = copyBytes(data);
  const loadingTask = pdfjsLib.getDocument({ data: bytes, wasmUrl: WASM_URL });
  const pdf = await loadingTask.promise;
  try {
    const total = Math.min(pdf.numPages, maxPages);
    const pages = []; // righe per pagina
    const allSizes = [];
    let totalChars = 0;

    for (let i = 1; i <= total; i++) {
      onProgress?.(i, total);
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const lines = groupLines(content.items);
      for (const l of lines) {
        totalChars += l.text.length;
        if (l.text.length >= 4) allSizes.push(Math.round(l.size));
      }
      pages.push(lines);
      page.cleanup();
    }

    // Nessun layer testo utile (pura scansione): ~< 20 caratteri per pagina.
    if (totalChars < Math.max(40, total * 20)) return null;

    // Dimensione del corpo = quella più frequente tra le righe di testo.
    const freq = new Map();
    for (const s of allSizes) freq.set(s, (freq.get(s) || 0) + 1);
    const body = [...freq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 0;
    const levelMap = buildLevelMap(allSizes, body);

    const out = [];
    pages.forEach((lines, p) => {
      if (total > 1) out.push(`<!-- pagina ${p + 1} -->`);
      let para = [];
      const flush = () => {
        if (para.length) {
          out.push(para.join(' '));
          para = [];
        }
      };
      let prevY = null;
      for (const l of lines) {
        if (!l.text) continue;
        // Titolo: dimensione maggiore del corpo e riga non troppo lunga
        // (un paragrafo lungo in corpo leggermente più grande non è un titolo).
        const lvl = l.text.length <= 120 ? levelMap.get(Math.round(l.size)) || 0 : 0;
        if (lvl) {
          flush();
          out.push(`${'#'.repeat(lvl)} ${l.text}`);
          prevY = l.y;
          continue;
        }
        // Stacco verticale ampio rispetto al corpo → nuovo paragrafo.
        if (prevY != null && Math.abs(prevY - l.y) > body * 1.8) flush();
        para.push(l.text);
        prevY = l.y;
      }
      flush();
    });

    const text = out.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
    return text || null;
  } finally {
    loadingTask.destroy();
  }
}
