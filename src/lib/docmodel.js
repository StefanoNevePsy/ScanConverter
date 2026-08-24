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
  // `chars` prevale sul testo: i blocchi riletti da IndexedDB conservano il
  // testo TRONCATO (ne basta un estratto per riconoscere i titoli) ma il
  // conteggio vero. Misurare un paragrafo da 1200 caratteri come se ne avesse
  // 400 gli attribuirebbe meno righe, quindi un corpo più grande — e la prosa
  // finirebbe promossa a titolo.
  const chars = Number.isFinite(block.chars) && block.chars > 0
    ? block.chars
    : String(block.text || '').replace(/\s+/g, ' ').trim().length;
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

/*
  ------------------------------------------------ applicazione al Markdown

  Il Markdown resta il formato di scambio di tutta la pipeline: cambiarlo
  significherebbe riscrivere strutturazione, traduzione, rilettura e verifiche
  di fedeltà tutte insieme. Qui si interviene solo sui LIVELLI dei titoli e
  sulle righe che non sono titoli affatto, lasciando intatto ogni altro
  carattere del documento.

  L'aggancio è per testo, non per posizione: i blocchi Markdown non
  corrispondono uno a uno a quelli dell'OCR (le didascalie si fondono con le
  figure, le note si agganciano alla prosa, l'arredo di pagina sparisce).
  I titoli però sono corti e distintivi, e sono gli unici che interessano.
*/

/** Chiave di confronto: ciò che sopravvive a spazi e maiuscole. */
function headingKey(text) {
  return String(text || '')
    .replace(/^#{1,6}\s+/, '')
    .replace(/<!--[^>]*-->/g, '')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Riscrive i livelli dei titoli del Markdown secondo i ruoli dedotti.
 *
 * Conservativo per costruzione: un titolo che compare più volte con livelli
 * diversi viene lasciato com'era, perché non c'è modo di sapere quale
 * occorrenza sia quale. Meglio un livello vecchio che uno sbagliato.
 *
 * @param {string} markdown
 * @param {Array} roles esito di `assignRoles`
 * @returns {{markdown:string, releveled:number, demoted:number}}
 */
export function applyRolesToMarkdown(markdown, roles) {
  const wanted = new Map();
  for (const role of roles || []) {
    if (role.role !== 'heading' && role.role !== 'toc-entry') continue;
    const key = headingKey(role.text);
    if (!key) continue;
    const level = role.role === 'heading' ? role.level : 0;
    if (wanted.has(key) && wanted.get(key) !== level) {
      wanted.set(key, null); // ambiguo: non si tocca
    } else if (!wanted.has(key)) {
      wanted.set(key, level);
    }
  }

  let releveled = 0;
  let demoted = 0;
  const out = String(markdown || '').split(/\n{2,}/).map((chunk) => {
    // Un blocco può cominciare con il commento di pagina: il titolo è dopo.
    const match = chunk.match(/^((?:<!--[^>]*-->\s*)*)(#{1,6})\s+/);
    if (!match) return chunk;
    const level = wanted.get(headingKey(chunk.replace(/^(?:<!--[^>]*-->\s*)*/, '')));
    if (level === undefined || level === null) return chunk;
    if (level === 0) {
      demoted++;
      return chunk.replace(/^((?:<!--[^>]*-->\s*)*)#{1,6}\s+/, '$1');
    }
    if (level === match[2].length) return chunk;
    releveled++;
    return chunk.replace(/^((?:<!--[^>]*-->\s*)*)#{1,6}\s+/, `$1${'#'.repeat(level)} `);
  });

  return { markdown: out.join('\n\n'), releveled, demoted };
}

/**
 * Deduce i ruoli dai blocchi conservati e li applica al Markdown della
 * sessione. Senza blocchi — documenti elaborati da versioni precedenti —
 * restituisce il Markdown invariato invece di fallire.
 *
 * @param {string} markdown
 * @param {Array<{page:number, blocks:Array}>} pages
 */
export function structureFromBlocks(markdown, pages) {
  if (!pages?.length) return { markdown, releveled: 0, demoted: 0, inventory: null };
  const { inventory, roles } = assignRoles(pages);
  // Senza livelli distinti non c'è niente da correggere, e riscrivere a caso
  // sarebbe peggio del punto di partenza.
  if (!inventory.levels.length) return { markdown, releveled: 0, demoted: 0, inventory };
  return { ...applyRolesToMarkdown(markdown, roles), inventory };
}

/*
  --------------------------------------------------------- note a margine

  Verificato sul codice attuale: una pagina con una nota stretta a sinistra e
  il corpo a destra viene letta come DUE COLONNE, quindi la nota esce prima di
  tutto il testo della pagina. Su un libro con note a margine ricorrenti ogni
  pagina comincerebbe con la nota.

  La causa è che l'XY-cut cerca il varco verticale più largo che nessun blocco
  attraversa — e fra la nota e la gabbia del testo quel varco c'è. È l'analisi
  corretta per due colonne e sbagliata per una colonna con apparato a fianco;
  a distinguerle non è la geometria del varco ma la LARGHEZZA relativa dei due
  lati: due colonne si somigliano, una nota a margine è molto più stretta.
*/

/** Quanto può essere larga una nota a margine rispetto alla gabbia. */
const MARGINALIA_MAX_WIDTH = 0.45;

/** Sovrapposizione orizzontale minima per considerare due blocchi allineati. */
const COLUMN_OVERLAP = 0.15;

/** Ampiezza orizzontale occupata dal grosso del testo della pagina. */
export function mainTextSpan(blocks) {
  const widths = (blocks || [])
    .filter((b) => b?.bbox)
    .map((b) => ({
      width: (b.bbox.xmax ?? 0) - (b.bbox.xmin ?? 0),
      xmin: b.bbox.xmin ?? 0,
      xmax: b.bbox.xmax ?? 0,
    }))
    .filter((b) => b.width > 0);
  if (!widths.length) return null;
  const widest = widths.reduce((a, b) => (b.width > a.width ? b : a));
  return { xmin: widest.xmin, xmax: widest.xmax, width: widest.width };
}

/**
 * Il blocco sta nel margine, a fianco della gabbia invece che dentro.
 *
 * Due condizioni insieme: è molto più stretto della gabbia, e non la
 * sovrappone. La seconda da sola marcherebbe come nota una colonna di un
 * impaginato a due colonne; la prima da sola marcherebbe un titolo corto.
 */
export function isMarginalia(block, span) {
  const bbox = block?.bbox;
  if (!bbox || !span) return false;
  const width = (bbox.xmax ?? 0) - (bbox.xmin ?? 0);
  if (width <= 0 || width > span.width * MARGINALIA_MAX_WIDTH) return false;
  const overlap = Math.min(bbox.xmax, span.xmax) - Math.max(bbox.xmin, span.xmin);
  return overlap <= width * COLUMN_OVERLAP;
}

/**
 * Separa le note a margine dal flusso principale della pagina.
 *
 * @returns {{flow:Array, margins:Array}} il corpo e ciò che gli sta a fianco
 */
export function splitMarginalia(blocks) {
  const span = mainTextSpan(blocks);
  if (!span) return { flow: blocks || [], margins: [] };
  const flow = [];
  const margins = [];
  for (const block of blocks || []) {
    (isMarginalia(block, span) ? margins : flow).push(block);
  }
  // Se «margine» risultasse metà pagina non è un margine: è un impaginato a
  // due colonne, e va lasciato all'XY-cut che sa leggerlo.
  if (margins.length >= flow.length) return { flow: blocks || [], margins: [] };
  return { flow, margins };
}

/*
  ------------------------------------------------------ figure e didascalie

  L'aggancio attuale confronta i CENTRI di figura e didascalia e non guarda
  l'asse orizzontale. Due conseguenze: su una pagina a due colonne una
  didascalia di sinistra può essere assegnata a una figura di destra alla
  stessa altezza; e su una figura alta la didascalia subito sotto il bordo
  dista dal centro più della soglia, quindi viene persa proprio quando è più
  ovvia.

  Qui si misura la distanza fra i BORDI che si fronteggiano, e si richiede che
  i due blocchi stiano sulla stessa colonna.
*/

/** Frazione di sovrapposizione orizzontale fra due riquadri. */
export function horizontalOverlap(a, b) {
  if (!a || !b) return 0;
  const left = Math.max(a.xmin ?? 0, b.xmin ?? 0);
  const right = Math.min(a.xmax ?? 0, b.xmax ?? 0);
  const shared = right - left;
  if (shared <= 0) return 0;
  const narrower = Math.min((a.xmax ?? 0) - (a.xmin ?? 0), (b.xmax ?? 0) - (b.xmin ?? 0));
  return narrower > 0 ? shared / narrower : 0;
}

/** Distanza verticale fra i bordi che si fronteggiano (0 se si toccano). */
export function verticalGap(a, b) {
  if (!a || !b) return Infinity;
  if ((b.ymin ?? 0) >= (a.ymax ?? 0)) return (b.ymin ?? 0) - (a.ymax ?? 0);
  if ((a.ymin ?? 0) >= (b.ymax ?? 0)) return (a.ymin ?? 0) - (b.ymax ?? 0);
  return 0;
}

const CAPTION_MAX_GAP = 0.06;
const CAPTION_MIN_OVERLAP = 0.35;

/**
 * Abbina ogni figura alla sua didascalia, sulla pagina.
 *
 * L'assegnazione è globale e non golosa: si ordinano tutte le coppie
 * possibili per distanza e si prende la migliore disponibile. Con due figure
 * vicine, la prima non ruba più la didascalia della seconda solo perché la
 * incontra per prima nell'ordine di lettura.
 *
 * @returns {Map<object, object>} figura → didascalia
 */
export function pairCaptions(pictures, captions) {
  const candidates = [];
  for (const picture of pictures || []) {
    for (const caption of captions || []) {
      const overlap = horizontalOverlap(picture.bbox, caption.bbox);
      if (overlap < CAPTION_MIN_OVERLAP) continue;
      const gap = verticalGap(picture.bbox, caption.bbox);
      if (gap > CAPTION_MAX_GAP) continue;
      // A parità di distanza vince la didascalia SOTTO: è la posizione
      // convenzionale, e sopra la figura si trova più spesso la fine del
      // paragrafo precedente.
      const below = (caption.bbox?.ymin ?? 0) >= (picture.bbox?.ymax ?? 0);
      candidates.push({ picture, caption, score: gap + (below ? 0 : 0.005) });
    }
  }
  candidates.sort((a, b) => a.score - b.score);

  const pairs = new Map();
  const takenCaptions = new Set();
  for (const { picture, caption } of candidates) {
    if (pairs.has(picture) || takenCaptions.has(caption)) continue;
    pairs.set(picture, caption);
    takenCaptions.add(caption);
  }
  return pairs;
}

/*
  ------------------------------------------------------------- ornamenti

  Nel libro reale tutte e sei le «figure» estratte erano decorazioni: il
  numero di capitolo stampato grande in apertura di pagina, il marchio
  dell'editore sul frontespizio. Nessuna aveva didascalia, e quattro
  precedevano immediatamente un titolo di capitolo.

  Non vengono buttate — un ritaglio scartato per errore è irrecuperabile — ma
  marcate, così arrivano alla revisione figure già deselezionate.
*/

/** La figura è piccola, in cima alla pagina e senza didascalia. */
export function isOrnament(picture, caption, pageBlocks) {
  const bbox = picture?.bbox;
  if (!bbox || caption) return false;
  const w = (bbox.xmax ?? 0) - (bbox.xmin ?? 0);
  const h = (bbox.ymax ?? 0) - (bbox.ymin ?? 0);
  if (w * h > 0.06) return false;
  const above = (pageBlocks || []).filter(
    (b) => b !== picture && (b.bbox?.ymax ?? 1) <= (bbox.ymin ?? 0),
  );
  return above.length === 0;
}
