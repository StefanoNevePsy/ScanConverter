/*
  Workflow «Scansione ricercabile».

  Per i libri che vale la pena tenere COME SONO: il PDF mostra le pagine
  originali (raddrizzate e schiarite), e sotto ogni pagina c'è il testo
  letto e corretto, invisibile. Si può cercare, selezionare, copiare, e
  un'IA lo legge come testo — ma l'occhio vede la scansione.

  Il testo di ogni pagina sta nella zona dove l'OCR ha trovato il testo,
  con un corpo calcolato per riempirla: la ricerca evidenzia la zona giusta
  della pagina, anche se non la riga esatta (l'OCR dà blocchi, non righe).
*/

import { sourcePlainText } from './strict.js';

const PAGE_WIDTH_PT = 595; // A4 in larghezza; l'altezza segue la proporzione della scansione.
const PAGE_MARK_RE = /<!--\s*pagina\s+(\d+)\s*-->/gi;

/**
 * Divide il testo canonico nelle pagine, usando i segni «<!-- pagina N -->».
 * @returns {string[]} testo semplice per pagina (indice 0 = pagina 1)
 */
export function splitTextByPage(markdown, pageCount) {
  const text = String(markdown || '');
  const pages = Array.from({ length: pageCount }, () => '');
  const marks = [...text.matchAll(PAGE_MARK_RE)];
  if (!marks.length) {
    pages[0] = text;
  } else {
    // Testo prima del primo segno: appartiene alla prima pagina.
    if (marks[0].index > 0) pages[0] += text.slice(0, marks[0].index);
    marks.forEach((m, i) => {
      const index = Number(m[1]) - 1;
      const end = i + 1 < marks.length ? marks[i + 1].index : text.length;
      if (index >= 0 && index < pageCount) pages[index] += `\n\n${text.slice(m.index + m[0].length, end)}`;
    });
  }
  return pages.map((p) =>
    sourcePlainText(p)
      .replace(/<\/?[a-z][^>]*>/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

/** Stringa Typst: solo barre rovesciate e virgolette vanno protette. */
const typstString = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

const round = (n) => Math.round(n * 10) / 10;

/**
 * Corpo del testo che riempie la zona: n caratteri, larghezza ≈ 0,5 corpo,
 * interlinea ≈ 1,25 corpo → n · 0,625 · corpo² ≈ area.
 */
function fittedSize(widthPt, heightPt, chars) {
  if (!chars) return 10;
  const size = Math.sqrt((widthPt * heightPt) / (chars * 0.625));
  return Math.min(14, Math.max(3, round(size)));
}

/**
 * Documento Typst completo.
 * @param {Array<{path:string, width:number, height:number, text:string,
 *   area?:{xmin:number,ymin:number,xmax:number,ymax:number}|null}>} pages
 */
export function buildScanTypst(pages) {
  const out = [
    '// Scansione ricercabile: pagine originali con il testo corretto invisibile sotto.',
    '#set page(margin: 0pt)',
    // Dichiarato qui: altrimenti l'app lo aggiunge al primo «set text» che
    // trova, e dentro «rgb(…)» romperebbe la sintassi.
    '#set text(hyphenate: false)',
    '#set par(justify: true, leading: 0.25em, spacing: 0.25em)',
    '',
  ];
  pages.forEach((p, i) => {
    const heightPt = round(PAGE_WIDTH_PT * (p.height / p.width));
    // Zona del testo trovata dall'OCR; senza, i margini abituali di un libro.
    const a = p.area || { xmin: 0.08, ymin: 0.06, xmax: 0.92, ymax: 0.94 };
    const x = round(a.xmin * PAGE_WIDTH_PT);
    const y = round(a.ymin * heightPt);
    const w = round(Math.max(20, (a.xmax - a.xmin) * PAGE_WIDTH_PT));
    const h = round(Math.max(20, (a.ymax - a.ymin) * heightPt));
    const size = fittedSize(w, h, p.text.length);
    out.push(`// pagina ${i + 1}`);
    out.push(`#page(width: ${PAGE_WIDTH_PT}pt, height: ${heightPt}pt)[`);
    out.push(`  #place(top + left, image(${typstString(p.path)}, width: 100%, height: 100%))`);
    if (p.text) {
      out.push(`  #place(top + left, dx: ${x}pt, dy: ${y}pt, block(width: ${w}pt, height: ${h}pt, clip: true)[`);
      out.push(`    #set text(size: ${size}pt, fill: rgb(0, 0, 0, 0))`);
      out.push(`    #${typstString(p.text)}`);
      out.push('  ])');
    }
    out.push(']');
    out.push('');
  });
  return out.join('\n');
}

/** Zona occupata dal testo: unione dei riquadri dei blocchi di testo. */
export function textAreaOf(blocks) {
  const boxes = (blocks || [])
    .filter((b) => b?.bbox && b.text && !/^(Picture|Figure|Image|Page-header|Page-footer)$/.test(b.type))
    .map((b) => b.bbox);
  if (!boxes.length) return null;
  return {
    xmin: Math.min(...boxes.map((b) => b.xmin)),
    ymin: Math.min(...boxes.map((b) => b.ymin)),
    xmax: Math.max(...boxes.map((b) => b.xmax)),
    ymax: Math.max(...boxes.map((b) => b.ymax)),
  };
}

/**
 * Pagina in JPEG per il PDF (solo browser): le scansioni in PNG peserebbero
 * centinaia di MB su un libro intero.
 * @returns {Promise<{bytes:Uint8Array, width:number, height:number}>}
 */
export async function pageToJpeg(dataUrl, quality = 0.82) {
  const img = await new Promise((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = reject;
    el.src = dataUrl;
  });
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  canvas.getContext('2d').drawImage(img, 0, 0);
  const jpeg = canvas.toDataURL('image/jpeg', quality);
  const bin = atob(jpeg.slice(jpeg.indexOf(',') + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, width: img.naturalWidth, height: img.naturalHeight };
}
