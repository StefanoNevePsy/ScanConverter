/*
  Modello a RUOLI del documento.

  Il problema che risolve, misurato su un libro vero (433 pagine, Boszormenyi-
  Nagy «Invisible Loyalties»): dei 16 titoli di livello 1 prodotti dalla
  pipeline, 11 erano righe dell'INDICE, uno una testatina corrente sfuggita al
  filtro, uno un numero di pagina incollato al titolo del capitolo. Dei dodici
  capitoli veri, quattro. Sotto, 233 titoli di livello 2 e 3 di livello 3:
  nessuna distinzione fra capitolo, sezione e sottosezione.

  La causa non è un algoritmo debole ma il momento in cui si decide. Il tipo
  semantico che l'OCR restituisce ha tre valori (Title / Section-header /
  Subsection-header) e viene deciso guardando UNA pagina: sulla pagina
  dell'indice la riga più grande è una riga d'indice, e diventa un titolo di
  livello 1. Su una pagina di sole sezioni, una sezione diventa il titolo.

  Qui la decisione si prende una volta sola, su TUTTO il libro, come fa da
  sempre `buildLevelMap` in pdftext.js per i PDF con testo vero: si misura un
  proxy del corpo tipografico di ogni blocco, si raggruppa, il gruppo più
  numeroso è il testo corrente e i gruppi più grandi diventano livelli 1, 2, 3
  in quell'ordine. Un capitolo stampato in corpo 20 resta capitolo anche nella
  pagina in cui è l'unica riga, e una sezione in corpo 12 resta sezione anche
  se su quella pagina non c'è nient'altro.

  RUOLO, NON RESA. Qui si decide soltanto CHE COSA è un blocco: capitolo,
  sezione, didascalia, nota, testatina, riga d'indice. Come apparirà — font,
  corpo, margini, dove va la didascalia — resta interamente nelle
  `layoutOptions` e nel preambolo Typst, liberamente modificabili dopo. È
  questa separazione che permette di conservare la struttura del libro senza
  ereditarne l'impaginazione.
*/

/**
 * Rapporto altezza/larghezza della pagina scansionata.
 *
 * Le bbox sono normalizzate 0–1 su ENTRAMBI gli assi, quindi un quadrato in
 * quelle coordinate non è un quadrato sulla carta: senza questa correzione la
 * stima del corpo tipografico sbaglia del 40% su un libro in formato normale.
 */
const DEFAULT_PAGE_ASPECT = 1.4;

// Larghezza media di un carattere in frazione del corpo, per un testo latino
// in tondo. Serve solo a stimare quante righe stanno in un blocco: conta il
// rapporto fra i blocchi, non il valore assoluto.
const GLYPH_ADVANCE = 0.5;

// Due corpi entro questa distanza relativa sono lo stesso stile. Sotto, il
// rumore di misura dell'OCR produrrebbe un livello di titolo per pagina.
const SAME_STYLE_TOLERANCE = 0.12;

/** Un titolo deve staccare dal corpo del testo di almeno questo. */
const HEADING_MIN_RATIO = 1.08;

export const MAX_HEADING_LEVEL = 4;

/**
 * Stima quante righe di testo contiene un blocco, e quindi il suo corpo.
 *
 * Da larghezza `W`, altezza `H` e `N` caratteri: se il blocco ha `k` righe,
 * ogni riga è alta `H/k` e contiene circa `W / (0.5 · H/k · aspect)`
 * caratteri. Imponendo che il totale faccia `N` si ottiene
 * `k = √(0.5 · N · H · aspect / W)`, e il corpo è `H/k`.
 *
 * @param {{bbox:object, text:string}} block
 * @param {number} [aspect] altezza/larghezza della pagina
 * @returns {{size:number, lines:number}|null} null se il blocco non è misurabile
 */
export function blockTypography(block, aspect = DEFAULT_PAGE_ASPECT) {
  const bbox = block?.bbox;
  if (!bbox) return null;
  const w = Math.max(0, (bbox.xmax ?? 0) - (bbox.xmin ?? 0));
  const h = Math.max(0, (bbox.ymax ?? 0) - (bbox.ymin ?? 0));
  const chars = String(block.text || '').replace(/\s+/g, ' ').trim().length;
  if (w <= 0 || h <= 0 || chars === 0) return null;

  const raw = Math.sqrt((GLYPH_ADVANCE * chars * h * aspect) / w);
  const lines = Math.max(1, Math.round(raw));
  return { size: h / lines, lines };
}

/**
 * Raggruppa i corpi tipografici in stili distinti.
 *
 * Per rango e non per soglia: si ordina, si apre un gruppo nuovo quando il
 * salto supera la tolleranza. Così un libro in corpo 9 e uno in corpo 14
 * danno la stessa gerarchia senza tarare niente.
 *
 * @param {number[]} sizes
 * @returns {{size:number, count:number}[]} gruppi dal più piccolo al più grande
 */
export function clusterSizes(sizes) {
  const sorted = sizes.filter((s) => Number.isFinite(s) && s > 0).sort((a, b) => a - b);
  if (!sorted.length) return [];
  const clusters = [];
  let members = [sorted[0]];
  for (const size of sorted.slice(1)) {
    const reference = members[members.length - 1];
    if (size <= reference * (1 + SAME_STYLE_TOLERANCE)) {
      members.push(size);
    } else {
      clusters.push(members);
      members = [size];
    }
  }
  clusters.push(members);
  return clusters.map((group) => ({
    // La mediana invece della media: un blocco mal misurato non sposta lo stile.
    size: group[Math.floor(group.length / 2)],
    count: group.length,
  }));
}

/**
 * Inventario degli stili del DOCUMENTO INTERO.
 *
 * È il punto in cui questa implementazione differisce da quella per pagina:
 * il corpo del testo si riconosce perché è lo stile con più blocchi in tutto
 * il libro — una proprietà che su una singola pagina può essere falsa e su
 * quattrocento non lo è mai.
 *
 * @param {Array<{bbox:object, text:string}>} blocks tutti i blocchi del libro
 * @returns {{body:number, levels:{size:number, level:number}[]}}
 */
export function buildStyleInventory(blocks, aspect = DEFAULT_PAGE_ASPECT) {
  const sizes = [];
  for (const block of blocks || []) {
    const metrics = blockTypography(block, aspect);
    if (metrics) sizes.push(metrics.size);
  }
  const clusters = clusterSizes(sizes);
  if (!clusters.length) return { body: 0, levels: [] };

  // Il corpo è lo stile più frequente; a parità di frequenza il più piccolo,
  // perché la prosa è più fitta di qualunque apparato.
  const body = clusters.reduce((best, c) => {
    if (c.count > best.count) return c;
    if (c.count === best.count && c.size < best.size) return c;
    return best;
  }, clusters[0]);

  const levels = clusters
    .filter((c) => c.size > body.size * HEADING_MIN_RATIO)
    .sort((a, b) => b.size - a.size)
    .slice(0, MAX_HEADING_LEVEL)
    .map((c, i) => ({ size: c.size, level: i + 1 }));

  return { body: body.size, levels };
}

/** Livello di titolo per un corpo tipografico, o 0 se è testo corrente. */
export function levelForSize(size, inventory) {
  if (!Number.isFinite(size) || !inventory?.levels?.length) return 0;
  for (const entry of inventory.levels) {
    if (size >= entry.size * (1 - SAME_STYLE_TOLERANCE)) return entry.level;
  }
  return 0;
}

/*
  ---------------------------------------------------------------- indice

  Le righe dell'indice sono la trappola peggiore, perché sono titoli VERI —
  solo, di un altro documento. Sulla pagina dell'indice sono anche le righe
  più grandi, quindi qualunque criterio tipografico le promuove.

  Si riconoscono da quattro cose insieme, mai da una sola: finiscono con un
  numero, stanno vicine fra loro, sono tante, e i numeri CRESCONO.

  L'ultima condizione non è un dettaglio. Senza, la prima riga dopo l'indice
  viene risucchiata dentro: il titolo del capitolo 1 finisce con «1», e in un
  libro vero è proprio lì che si trova, subito dopo l'ultima riga d'indice.
  Ma quell'1 arriva dopo un 141, e i numeri di pagina di un indice non
  tornano indietro.
*/

const TOC_LINE_RE = /[^\s.]\s*\.{0,}\s*(\d{1,4})\s*$/;
const MIN_TOC_RUN = 4;

/** Numero finale della riga, se c'è: è il candidato numero di pagina. */
function trailingNumber(text) {
  const match = String(text || '').replace(/\s+/g, ' ').trim().match(TOC_LINE_RE);
  return match ? Number(match[1]) : null;
}

/**
 * Marca i blocchi che appartengono a un indice.
 *
 * @param {Array<{text:string}>} blocks in ordine di lettura
 * @returns {Set<number>} indici dei blocchi che sono righe d'indice
 */
export function findTableOfContents(blocks) {
  const marked = new Set();
  let run = [];
  let last = -Infinity;

  const flush = () => {
    if (run.length >= MIN_TOC_RUN) for (const i of run) marked.add(i);
    run = [];
    last = -Infinity;
  };

  for (let i = 0; i < (blocks?.length || 0); i++) {
    const text = String(blocks[i]?.text || '').replace(/\s+/g, ' ').trim();
    const number = text && text.length <= 160 ? trailingNumber(text) : null;
    if (number === null) {
      flush();
      continue;
    }
    if (number < last) {
      // La numerazione è tornata indietro: l'indice finisce qui, e questa riga
      // può essere l'inizio di un altro indice (elenco delle figure, indice
      // analitico), quindi apre una serie nuova invece di essere scartata.
      flush();
    }
    run.push(i);
    last = number;
  }
  flush();
  return marked;
}

/*
  ------------------------------------------------------- apertura di capitolo

  Un capitolo, in un libro stampato, comincia su una pagina nuova e CALATO:
  sopra di lui c'è più bianco del margine normale. È il segnale che usa anche
  un lettore umano, ed è indipendente dal corpo tipografico — quindi serve
  proprio quando quello non basta, cioè quando capitolo e sezione sono
  stampati nello stesso corpo.

  Non basta «è il primo blocco della pagina»: anche una sezione può capitare
  in cima a una pagina, ed è il caso più frequente in assoluto. A separarli è
  quanto bianco c'è sopra.
*/

/** Margine superiore tipico del libro: la mediana del primo blocco di ogni pagina. */
export function documentTopMargin(pages) {
  const tops = [];
  for (const page of pages || []) {
    const values = (page.blocks || [])
      .map((b) => b?.bbox?.ymin)
      .filter((v) => Number.isFinite(v));
    if (values.length) tops.push(Math.min(...values));
  }
  if (!tops.length) return 0;
  tops.sort((a, b) => a - b);
  return tops[Math.floor(tops.length / 2)];
}

/** Quanto bianco in più, oltre al margine normale, marca un'apertura. */
const CHAPTER_DROP = 0.05;

/**
 * Il blocco apre la pagina con uno stacco anomalo sopra di sé.
 *
 * @param {object} block
 * @param {Array} pageBlocks tutti i blocchi della stessa pagina
 * @param {number} [topMargin] margine superiore tipico del documento
 */
export function opensPage(block, pageBlocks, topMargin = 0) {
  const top = block?.bbox?.ymin;
  if (!Number.isFinite(top)) return false;
  // Oltre un terzo di pagina non è più un'apertura ma un titolo nel flusso.
  if (top > 0.34) return false;
  const isFirst = !pageBlocks.some(
    (other) => other !== block && (other.bbox?.ymin ?? 1) < top - 0.01,
  );
  return isFirst && top >= topMargin + CHAPTER_DROP;
}

/*
  ------------------------------------------------------------------- ruoli
*/

const PICTURE_TYPES = new Set(['Picture', 'Figure', 'Image']);
const CAPTION_TYPES = new Set(['Caption']);
const TABLE_TYPES = new Set(['Table']);
const FURNITURE_TYPES = new Set(['Page-header', 'Page-footer']);

/**
 * Assegna a ogni blocco il suo ruolo nel documento.
 *
 * @param {Array<{blocks:Array, page:number}>} pages pagine con i loro blocchi
 * @param {object} [options]
 * @param {number} [options.aspect]
 * @returns {{inventory:object, roles:Array}} un ruolo per blocco, in ordine
 */
export function assignRoles(pages, options = {}) {
  const aspect = options.aspect ?? DEFAULT_PAGE_ASPECT;
  const flat = [];
  for (const page of pages || []) {
    for (const block of page.blocks || []) {
      flat.push({ block, page: page.page, siblings: page.blocks });
    }
  }

  // L'inventario si costruisce SOLO sul testo: figure e tabelle hanno riquadri
  // grandi che falserebbero i gruppi, e le testatine sono minuscole.
  const textual = flat.filter(
    ({ block }) =>
      !PICTURE_TYPES.has(block.type) &&
      !TABLE_TYPES.has(block.type) &&
      !FURNITURE_TYPES.has(block.type) &&
      String(block.text || '').trim(),
  );
  const inventory = buildStyleInventory(textual.map((e) => e.block), aspect);
  const toc = findTableOfContents(flat.map((e) => e.block));
  const topMargin = documentTopMargin(pages);

  const roles = flat.map((entry, index) => {
    const { block, page, siblings } = entry;
    const metrics = blockTypography(block, aspect);
    const base = {
      index,
      page,
      text: block.text || '',
      bbox: block.bbox || null,
      ocrType: block.type || 'Text',
      size: metrics?.size ?? null,
    };

    if (PICTURE_TYPES.has(block.type)) return { ...base, role: 'figure' };
    if (CAPTION_TYPES.has(block.type)) return { ...base, role: 'caption' };
    if (TABLE_TYPES.has(block.type)) return { ...base, role: 'table' };
    if (FURNITURE_TYPES.has(block.type)) return { ...base, role: 'furniture' };
    // Una riga d'indice è un titolo di un ALTRO documento: va resa come voce
    // di elenco, non come titolo di questo.
    if (toc.has(index)) return { ...base, role: 'toc-entry' };

    const level = levelForSize(metrics?.size, inventory);
    if (!level) return { ...base, role: 'body' };

    // Se la tipografia distingue già più livelli, ci si fida di quella: è la
    // misura, non un indizio. L'apertura di pagina serve SOLO quando capitoli
    // e sezioni sono stampati nello stesso corpo e il libro sarebbe piatto —
    // il caso in cui l'unico segnale rimasto è che il capitolo apre la pagina.
    const opening = opensPage(block, siblings, topMargin);
    const ambiguous = inventory.levels.length < 2;
    return {
      ...base,
      role: 'heading',
      level: ambiguous && opening ? 1 : ambiguous ? 2 : level,
      opensPage: opening,
    };
  });

  return { inventory, roles };
}
