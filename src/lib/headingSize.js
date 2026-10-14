/*
  Dimensione dei titoli RELATIVA al testo vicino.

  La dimensione assoluta dei caratteri in una scansione non è affidabile:
  in una foto col telefono la prospettiva rimpicciolisce il lato lontano,
  la curvatura vicino alla rilegatura schiaccia le righe, lo zoom cambia da
  pagina a pagina. Ma tutto questo deforma ALLO STESSO MODO un titolo e il
  paragrafo che gli sta accanto. Il rapporto fra i due resta stabile: è
  quello che si misura qui.

  Altezza di riga stimata senza contare le righe: un blocco di n caratteri
  occupa circa n × (larghezza carattere × altezza riga), e la larghezza di
  un carattere è circa metà dell'altezza. Quindi altezza ≈ √(2·area / n).
  Vale per un titolo di una riga come per un paragrafo di venti.
*/

const HEADING_TYPES = new Set([
  'Title', 'Document-title', 'Section-header', 'Heading', 'Subsection-header', 'Subheading',
]);

function lineHeight(b) {
  const box = b?.bbox;
  const n = String(b?.text || '').replace(/\s+/g, '').length;
  if (!box || n < 3) return null;
  const w = box.xmax - box.xmin;
  const h = box.ymax - box.ymin;
  if (!(w > 0 && h > 0)) return null;
  return Math.sqrt((2 * w * h) / n);
}

/** Chiave di confronto di un titolo, stabile alle correzioni tipografiche. */
export function headingKey(text) {
  return String(text || '')
    .replace(/^#{1,6}\s+/, '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .slice(0, 80);
}

/**
 * Per ogni titolo della pagina: rapporto fra la sua altezza di riga e quella
 * dei paragrafi più vicini. Senza paragrafi sulla pagina, niente misura.
 * @returns {Array<{key:string, ratio:number}>}
 */
export function headingSizeRatios(blocks) {
  const body = [];
  for (const b of blocks || []) {
    if (b?.type !== 'Text' || String(b.text || '').length < 60) continue;
    const lh = lineHeight(b);
    if (lh) body.push({ lh, cy: (b.bbox.ymin + b.bbox.ymax) / 2, cx: (b.bbox.xmin + b.bbox.xmax) / 2 });
  }
  if (!body.length) return [];
  const out = [];
  for (const b of blocks || []) {
    if (!HEADING_TYPES.has(b?.type)) continue;
    const lh = lineHeight(b);
    if (!lh) continue;
    const cy = (b.bbox.ymin + b.bbox.ymax) / 2;
    const cx = (b.bbox.xmin + b.bbox.xmax) / 2;
    // I tre paragrafi più vicini: la deformazione è locale.
    const near = body
      .map((p) => ({ lh: p.lh, d: Math.hypot(p.cx - cx, (p.cy - cy) * 1.5) }))
      .sort((a, z) => a.d - z.d);
    // Solo quelli davvero vicini: un paragrafo all'altro capo di una pagina
    // fotografata storta ha un corpo diverso per effetto della prospettiva.
    const close = near
      .filter((p, i) => i === 0 || p.d <= near[0].d * 2 + 0.05)
      .slice(0, 3)
      .map((p) => p.lh)
      .sort((a, z) => a - z);
    const ref = close[Math.floor((close.length - 1) / 2)];
    const key = headingKey(b.text);
    if (ref > 0 && key) out.push({ key, ratio: Math.round((lh / ref) * 100) / 100 });
  }
  return out;
}

/** Unisce le misure di tutte le pagine: mediana per titolo. */
export function mergeHeadingSizes(pages) {
  const all = new Map();
  for (const page of pages || []) {
    for (const item of page || []) {
      if (!item?.key || !(item.ratio > 0)) continue;
      if (!all.has(item.key)) all.set(item.key, []);
      all.get(item.key).push(item.ratio);
    }
  }
  const out = new Map();
  for (const [key, list] of all) {
    list.sort((a, z) => a - z);
    out.set(key, list[Math.floor(list.length / 2)]);
  }
  return out;
}

/**
 * Raggruppa le dimensioni in «taglie»: valori vicini (entro ~15%) sono la
 * stessa taglia anche se la prospettiva li ha resi un po' diversi. Si taglia
 * dove c'è un salto netto, non a soglie fisse.
 * @param {number[]} ratios
 * @returns {Map<number, number>} rapporto → taglia (0 = la più grande)
 */
export function sizeClasses(ratios) {
  const sorted = [...new Set(ratios.filter((r) => r > 0))].sort((a, z) => z - a);
  const classes = new Map();
  let cls = 0;
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && Math.log(sorted[i - 1] / sorted[i]) > 0.14) cls++;
    classes.set(sorted[i], cls);
  }
  return classes;
}
