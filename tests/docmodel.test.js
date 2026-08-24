/*
  I casi di questo file NON sono inventati: riproducono i difetti misurati sul
  progetto reale di «Invisible Loyalties» (433 pagine), dove la pipeline
  attuale produceva 16 titoli di livello 1 di cui 11 righe dell'indice, e 233
  titoli di livello 2 contro 3 di livello 3 — cioè nessuna gerarchia.

  La proprietà che conta, e che nessun criterio per-pagina può avere: lo stesso
  corpo tipografico deve dare lo stesso livello OVUNQUE nel libro, anche nelle
  pagine dove quel blocco è l'unico titolo presente.
*/

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assignRoles,
  blockTypography,
  buildStyleInventory,
  clusterSizes,
  findTableOfContents,
  levelForSize,
  opensPage,
} from '../src/lib/docmodel.js';

/* ------------------------------------------------ costruzione di un libro */

const PAGE_ASPECT = 1.4;

/**
 * Un blocco con bbox coerente col corpo tipografico richiesto.
 * `size` è l'altezza di UNA riga in frazione di pagina (0.02 ≈ corpo 11 su A4).
 */
function block(type, text, { size = 0.02, top = 0.1, left = 0.12, width = 0.76 } = {}) {
  const chars = text.replace(/\s+/g, ' ').trim().length;
  // Quante righe servono davvero a quel testo in quella larghezza.
  const perLine = Math.max(1, width / (0.5 * size * PAGE_ASPECT));
  const lines = Math.max(1, Math.round(chars / perLine));
  return {
    type,
    text,
    bbox: { xmin: left, xmax: left + width, ymin: top, ymax: top + size * lines },
  };
}

const PROSE =
  'Il paziente designato porta il sintomo per conto di un sistema che non ' +
  'riesce a nominare il proprio debito, e la lealtà invisibile che lo lega ' +
  'alla generazione precedente resta fuori dal discorso terapeutico finché ' +
  'qualcuno non la rende dicibile davanti a tutti i membri della famiglia.';

/* --------------------------------------------------------------- misura */

test('la stima del corpo distingue titolo, sezione e prosa', () => {
  const chapter = blockTypography(block('Text', 'La Teoria Dialettica', { size: 0.038 }), PAGE_ASPECT);
  const section = blockTypography(block('Text', 'LEALTÀ E MERITO', { size: 0.026 }), PAGE_ASPECT);
  const body = blockTypography(block('Text', PROSE, { size: 0.018 }), PAGE_ASPECT);

  assert.ok(chapter.size > section.size, `${chapter.size} > ${section.size}`);
  assert.ok(section.size > body.size, `${section.size} > ${body.size}`);
  assert.ok(body.lines >= 3, `la prosa deve risultare su più righe, non ${body.lines}`);
});

test('il conteggio vero dei caratteri prevale sul testo troncato', () => {
  // I blocchi riletti da IndexedDB conservano solo un estratto del testo. Se
  // la misura si basasse su quello, un paragrafo lungo sembrerebbe stare in
  // meno righe — quindi in corpo più grande — e verrebbe preso per un titolo.
  const long = block('Text', PROSE.repeat(4), { size: 0.018 });
  const truncated = { ...long, text: long.text.slice(0, 400), chars: long.text.length };
  const full = blockTypography(long, PAGE_ASPECT);
  const stored = blockTypography(truncated, PAGE_ASPECT);
  assert.ok(
    Math.abs(stored.size - full.size) < full.size * 0.02,
    `troncato ${stored.size} vs intero ${full.size}`,
  );

  // Senza il conteggio, la stessa prosa risulterebbe molto più «grande».
  const naive = blockTypography({ ...truncated, chars: undefined }, PAGE_ASPECT);
  assert.ok(naive.size > full.size * 1.3, 'il difetto deve essere reale, non teorico');
});

test('un blocco senza riquadro o senza testo non è misurabile', () => {
  assert.equal(blockTypography({ text: 'x', bbox: null }), null);
  assert.equal(blockTypography({ text: '   ', bbox: { xmin: 0, xmax: 1, ymin: 0, ymax: 1 } }), null);
});

test('corpi vicini finiscono nello stesso stile, corpi distinti no', () => {
  const clusters = clusterSizes([0.020, 0.0205, 0.021, 0.0195, 0.034, 0.035, 0.050]);
  assert.equal(clusters.length, 3, JSON.stringify(clusters));
  assert.equal(clusters[0].count, 4, 'i quattro corpi di prosa sono un gruppo solo');
});

/* ------------------------------------------------------------ inventario */

test('il corpo del testo è lo stile più frequente, non il più grande', () => {
  const blocks = [
    block('Text', 'UN TITOLO GRANDE', { size: 0.05 }),
    ...Array.from({ length: 20 }, () => block('Text', PROSE, { size: 0.018 })),
  ];
  const inventory = buildStyleInventory(blocks, PAGE_ASPECT);
  const bodySize = blockTypography(block('Text', PROSE, { size: 0.018 }), PAGE_ASPECT).size;
  assert.ok(Math.abs(inventory.body - bodySize) < bodySize * 0.15, `${inventory.body} vs ${bodySize}`);
  assert.equal(inventory.levels.length, 1);
});

test('una pagina di sola prosa non inventa nessun titolo', () => {
  const blocks = Array.from({ length: 12 }, () => block('Text', PROSE, { size: 0.018 }));
  assert.deepEqual(buildStyleInventory(blocks, PAGE_ASPECT).levels, []);
});

test('i livelli sono ordinati per corpo decrescente', () => {
  const blocks = [
    ...Array.from({ length: 30 }, () => block('Text', PROSE, { size: 0.018 })),
    ...Array.from({ length: 4 }, () => block('Text', 'CAPITOLO PRIMO', { size: 0.045 })),
    ...Array.from({ length: 9 }, () => block('Text', 'UNA SEZIONE', { size: 0.030 })),
  ];
  const { levels } = buildStyleInventory(blocks, PAGE_ASPECT);
  assert.equal(levels.length, 2);
  assert.ok(levels[0].size > levels[1].size);
  assert.deepEqual(levels.map((l) => l.level), [1, 2]);
  assert.equal(levelForSize(levels[0].size, { levels }), 1);
  assert.equal(levelForSize(levels[1].size, { levels }), 2);
  assert.equal(levelForSize(0.001, { levels }), 0, 'la prosa non è un titolo');
});

/* ------------------------------------------------------------------ indice */

test('le righe dell’indice non diventano titoli', () => {
  // Il difetto misurato: 11 dei 16 titoli di livello 1 erano righe d’indice.
  const toc = [
    block('Section-header', '1. CONCEPTS OF THE RELATIONAL SYSTEM 1', { size: 0.03 }),
    block('Section-header', '2. THE DIALECTIC THEORY OF RELATIONSHIPS 18', { size: 0.03 }),
    block('Section-header', '3. LOYALTY 37', { size: 0.03 }),
    block('Section-header', '4. JUSTICE AND SOCIAL DYNAMICS 53', { size: 0.03 }),
    block('Section-header', '5. BALANCE AND IMBALANCE IN RELATIONSHIPS 100', { size: 0.03 }),
  ];
  const marked = findTableOfContents(toc);
  assert.equal(marked.size, 5, 'tutte e cinque le righe sono indice');
});

test('un titolo isolato che finisce con una cifra non è un indice', () => {
  const blocks = [
    block('Text', PROSE, { size: 0.018 }),
    block('Section-header', 'La crisi del 1968', { size: 0.03 }),
    block('Text', PROSE, { size: 0.018 }),
  ];
  assert.equal(findTableOfContents(blocks).size, 0, 'serve una serie, non una riga sola');
});

test('l’indice con i puntini di guida viene riconosciuto', () => {
  const blocks = Array.from({ length: 6 }, (_, i) =>
    block('Text', `Capitolo ${i + 1} ....... ${10 + i * 12}`, { size: 0.022 }));
  assert.equal(findTableOfContents(blocks).size, 6);
});

/* ------------------------------------------------------- apertura di pagina */

test('apre la pagina solo il primo blocco in alto', () => {
  const first = block('Text', 'CAPITOLO SECONDO', { size: 0.04, top: 0.18 });
  const later = block('Text', PROSE, { size: 0.018, top: 0.30 });
  const page = [first, later];
  assert.equal(opensPage(first, page, 0.08), true, 'calato di 10 punti sotto il margine');
  assert.equal(opensPage(later, page, 0.08), false);
  assert.equal(opensPage(first, page, 0.16), false, 'senza stacco non è un’apertura');
});

test('un titolo a metà pagina non è un’apertura', () => {
  const head = block('Text', 'UNA SEZIONE', { size: 0.03, top: 0.55 });
  const page = [block('Text', PROSE, { size: 0.018, top: 0.10 }), head];
  assert.equal(opensPage(head, page, 0.08), false);
});

/* -------------------------------------------------- il libro, tutto intero */

/** Libro sintetico: capitoli in corpo grande, sezioni medio, prosa piccolo. */
function buildBook({ chapterSize = 0.042, sectionSize = 0.028 } = {}) {
  const pages = [];
  let page = 1;

  // Indice: righe grandi quanto una sezione, con il numero di pagina in coda.
  pages.push({
    page: page++,
    blocks: Array.from({ length: 8 }, (_, i) =>
      block('Section-header', `${i + 1}. TITOLO DEL CAPITOLO ${i + 1} ${1 + i * 20}`,
        { size: sectionSize, top: 0.08 + i * 0.07 })),
  });

  for (let c = 1; c <= 6; c++) {
    // Apertura di capitolo: il titolo è solo, in alto.
    pages.push({
      page: page++,
      blocks: [
        block('Section-header', `${c}. TITOLO DEL CAPITOLO ${c}`, { size: chapterSize, top: 0.20 }),
        block('Text', PROSE, { size: 0.018, top: 0.34 }),
      ],
    });
    // Pagine di sezioni. La prima ha la sezione in cima: è il caso che un
    // criterio per-pagina promuoverebbe erroneamente a capitolo.
    for (let sec = 0; sec < 3; sec++) {
      pages.push({
        page: page++,
        blocks: [
          block('Section-header', `SEZIONE ${c}.${sec + 1}`, { size: sectionSize, top: 0.08 }),
          block('Text', PROSE, { size: 0.018, top: 0.16 }),
          block('Text', PROSE, { size: 0.018, top: 0.50 }),
        ],
      });
    }
  }
  return pages;
}

test('la gerarchia del libro esce giusta: capitoli 1, sezioni 2', () => {
  const { inventory, roles } = assignRoles(buildBook());
  assert.equal(inventory.levels.length, 2, JSON.stringify(inventory));

  const headings = roles.filter((r) => r.role === 'heading');
  const chapters = headings.filter((r) => r.level === 1);
  const sections = headings.filter((r) => r.level === 2);

  assert.equal(chapters.length, 6, 'un livello 1 per capitolo, e nessun altro');
  assert.equal(sections.length, 18, '3 sezioni × 6 capitoli');
  for (const c of chapters) assert.match(c.text, /^\d+\. TITOLO DEL CAPITOLO/);
  for (const s of sections) assert.match(s.text, /^SEZIONE/);
});

test('una sezione in cima alla pagina resta sezione', () => {
  // È il difetto che rende piatta la gerarchia: deciso pagina per pagina,
  // quel blocco è l’unico titolo presente e diventa il titolo della pagina.
  const pages = buildBook();
  const { roles } = assignRoles(pages);

  // Il primo blocco di ogni pagina, calcolato qui indipendentemente dal codice
  // sotto test: la proprietà da verificare è il LIVELLO, non come ci si arriva.
  const firstOfPage = new Set();
  for (const page of pages) {
    const first = [...page.blocks].sort((a, b) => a.bbox.ymin - b.bbox.ymin)[0];
    if (first) firstOfPage.add(first.text);
  }
  const sectionsOnTop = roles.filter(
    (r) => r.role === 'heading' && /^SEZIONE/.test(r.text) && firstOfPage.has(r.text),
  );
  assert.ok(sectionsOnTop.length >= 6, `il caso deve esistere: ${sectionsOnTop.length}`);
  for (const r of sectionsOnTop) assert.equal(r.level, 2, `${r.text} promosso a ${r.level}`);
});

test('le righe d’indice restano fuori dalla gerarchia', () => {
  const { roles } = assignRoles(buildBook());
  const toc = roles.filter((r) => r.role === 'toc-entry');
  assert.equal(toc.length, 8, 'le otto righe d’indice');
  // I titoli di capitolo veri finiscono anch'essi con una cifra: il controllo
  // deve essere sulle righe d'indice esatte, non sulla forma.
  const tocTexts = new Set(toc.map((r) => r.text));
  assert.equal(
    roles.some((r) => r.role === 'heading' && tocTexts.has(r.text)),
    false,
    'nessuna riga d’indice è finita fra i titoli',
  );
  assert.ok(tocTexts.has('1. TITOLO DEL CAPITOLO 1 1'), 'la prima riga d’indice è riconosciuta');
});

test('la prosa non viene mai promossa', () => {
  const { roles } = assignRoles(buildBook());
  const promoted = roles.filter((r) => r.role === 'heading' && r.text.startsWith('Il paziente'));
  assert.deepEqual(promoted, []);
});

test('se capitoli e sezioni hanno lo stesso corpo, decide l’apertura di pagina', () => {
  // Molti libri stampano capitolo e sezione nello stesso corpo: lì la
  // tipografia non basta e l’unico segnale rimasto è che il capitolo apre la
  // pagina. Fuori da questo caso il segnale non viene usato.
  const { inventory, roles } = assignRoles(buildBook({ chapterSize: 0.028, sectionSize: 0.028 }));
  assert.equal(inventory.levels.length, 1, 'un solo stile di titolo: caso ambiguo');
  const chapters = roles.filter((r) => r.role === 'heading' && r.level === 1);
  assert.equal(chapters.length, 6);
  for (const c of chapters) assert.match(c.text, /^\d+\. TITOLO DEL CAPITOLO/);
});

test('figure, didascalie, tabelle e testatine hanno un ruolo proprio', () => {
  const pages = [{
    page: 1,
    blocks: [
      block('Page-header', '6 Legami Invisibili', { size: 0.014, top: 0.03 }),
      block('Section-header', 'UNA SEZIONE', { size: 0.028, top: 0.10 }),
      block('Text', PROSE, { size: 0.018, top: 0.18 }),
      block('Picture', '', { size: 0.3, top: 0.45 }),
      block('Caption', 'Figura 1. Lo schema del debito', { size: 0.016, top: 0.78 }),
      block('Table', '', { size: 0.1, top: 0.85 }),
    ],
  }];
  const byRole = {};
  for (const r of assignRoles(pages).roles) byRole[r.role] = (byRole[r.role] || 0) + 1;
  assert.equal(byRole.furniture, 1, 'la testatina non è contenuto');
  assert.equal(byRole.caption, 1);
  assert.equal(byRole.table, 1);
  assert.equal(byRole.figure, 1);
});

test('senza riquadri non si inventa una gerarchia', () => {
  const pages = [{ page: 1, blocks: [{ type: 'Text', text: PROSE, bbox: null }] }];
  const { inventory, roles } = assignRoles(pages);
  assert.deepEqual(inventory.levels, []);
  assert.equal(roles[0].role, 'body');
});
