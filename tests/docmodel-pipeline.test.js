/*
  Dai blocchi dell'OCR al Markdown corretto, passando dallo store.

  `docmodel.test.js` verifica la deduzione dei ruoli; qui si verifica che
  quella deduzione arrivi davvero al documento — che è il punto in cui la
  catena si era sempre spezzata: la geometria esisteva, veniva calcolata, e
  poi moriva dentro `assemblePage` senza raggiungere nessuno.
*/

import test from 'node:test';
import assert from 'node:assert/strict';

import { applyRolesToMarkdown, assignRoles, structureFromBlocks } from '../src/lib/docmodel.js';

const PAGE_ASPECT = 1.4;

function block(type, text, { size = 0.02, top = 0.1, left = 0.12, width = 0.76 } = {}) {
  const chars = text.replace(/\s+/g, ' ').trim().length;
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
  'alla generazione precedente resta fuori dal discorso terapeutico.';

/**
 * Ricostruisce il difetto misurato sul libro vero: indice in apertura, poi
 * capitoli e sezioni. L'OCR marca TUTTO come Section-header, perché su ogni
 * singola pagina quello è il blocco più grande.
 */
function damagedBook() {
  const pages = [];
  let n = 1;
  pages.push({
    page: n++,
    blocks: [
      block('Section-header', '1. CONCETTI DEL SISTEMA RELAZIONALE 1', { size: 0.026, top: 0.10 }),
      block('Section-header', '2. LA TEORIA DIALETTICA 18', { size: 0.026, top: 0.17 }),
      block('Section-header', '3. LEALTÀ 37', { size: 0.026, top: 0.24 }),
      block('Section-header', '4. GIUSTIZIA E DINAMICHE SOCIALI 53', { size: 0.026, top: 0.31 }),
      block('Section-header', '5. EQUILIBRIO E SQUILIBRIO 100', { size: 0.026, top: 0.38 }),
    ],
  });
  for (const [num, title] of [[1, 'CONCETTI DEL SISTEMA RELAZIONALE'], [2, 'LA TEORIA DIALETTICA']]) {
    pages.push({
      page: n++,
      blocks: [
        block('Section-header', `${num}. ${title}`, { size: 0.040, top: 0.22 }),
        block('Text', PROSE, { size: 0.018, top: 0.36 }),
      ],
    });
    for (const sub of ['I CONFINI RELAZIONALI', 'GERARCHIA DELL’OBBLIGAZIONE']) {
      pages.push({
        page: n++,
        blocks: [
          block('Section-header', `${sub} ${num}`, { size: 0.026, top: 0.08 }),
          block('Text', PROSE, { size: 0.018, top: 0.15 }),
          block('Text', PROSE, { size: 0.018, top: 0.55 }),
        ],
      });
    }
  }
  return pages;
}

/** Il Markdown che la pipeline produce oggi: tutto livello 2, indice incluso. */
function markdownAsToday(pages) {
  const chunks = [];
  for (const page of pages) {
    chunks.push(`<!-- pagina ${page.page} -->`);
    for (const b of page.blocks) {
      chunks.push(b.type === 'Section-header' ? `## ${b.text}` : b.text);
    }
  }
  return chunks.join('\n\n');
}

test('la gerarchia piatta di oggi diventa capitoli e sezioni', () => {
  const pages = damagedBook();
  const before = markdownAsToday(pages);

  // Punto di partenza: nessun livello 1, tutto livello 2 — il difetto misurato.
  assert.equal((before.match(/^# /gm) || []).length, 0);
  assert.equal((before.match(/^## /gm) || []).length, 11, '5 righe d’indice + 2 capitoli + 4 sezioni');

  const after = structureFromBlocks(before, pages);
  const heads = (level) => (after.markdown.match(new RegExp(`^#{${level}} `, 'gm')) || []).length;

  assert.equal(heads(1), 2, 'i due capitoli veri');
  assert.equal(heads(2), 4, 'le quattro sezioni');
  assert.equal(after.demoted, 5, 'le cinque righe d’indice non sono più titoli');
});

test('le righe d’indice restano nel testo, solo non più come titoli', () => {
  const pages = damagedBook();
  const after = structureFromBlocks(markdownAsToday(pages), pages);
  assert.match(after.markdown, /^1\. CONCETTI DEL SISTEMA RELAZIONALE 1$/m);
  assert.equal(/^#+ 1\. CONCETTI DEL SISTEMA RELAZIONALE 1$/m.test(after.markdown), false);
});

test('nessun carattere del testo viene alterato, solo i cancelletti', () => {
  const pages = damagedBook();
  const before = markdownAsToday(pages);
  const after = structureFromBlocks(before, pages).markdown;
  const strip = (s) => s.replace(/^#{1,6}\s+/gm, '').replace(/\s+/g, ' ').trim();
  assert.equal(strip(after), strip(before), 'il contenuto deve essere identico');
});

test('un documento senza blocchi conservati resta com’è', () => {
  // I documenti elaborati prima di questa modifica non hanno la geometria:
  // devono continuare a funzionare, non a fallire.
  const before = '## Un titolo\n\nDel testo.';
  const out = structureFromBlocks(before, []);
  assert.equal(out.markdown, before);
  assert.equal(out.releveled, 0);
  assert.equal(out.demoted, 0);
});

test('se non emergono livelli distinti non si tocca niente', () => {
  const pages = [{
    page: 1,
    blocks: Array.from({ length: 8 }, () => block('Text', PROSE, { size: 0.018 })),
  }];
  const before = '## Un titolo\n\nDel testo.';
  assert.equal(structureFromBlocks(before, pages).markdown, before);
});

test('un titolo ambiguo — stesso testo, livelli diversi — non viene toccato', () => {
  // «Conclusioni» compare in sei capitoli del libro vero. Se le occorrenze
  // ricevessero livelli diversi non ci sarebbe modo di sapere quale è quale:
  // meglio lasciare il livello vecchio che sceglierne uno a caso.
  const roles = [
    { role: 'heading', level: 1, text: 'Conclusioni' },
    { role: 'heading', level: 3, text: 'Conclusioni' },
  ];
  const before = '## Conclusioni\n\nTesto.';
  assert.equal(applyRolesToMarkdown(before, roles).markdown, before);
});

test('il commento di pagina davanti al titolo non impedisce la correzione', () => {
  const roles = [{ role: 'heading', level: 1, text: 'La Teoria Dialettica' }];
  const before = '<!-- pagina 43 -->\n## La Teoria Dialettica';
  const after = applyRolesToMarkdown(before, roles);
  assert.equal(after.markdown, '<!-- pagina 43 -->\n# La Teoria Dialettica');
  assert.equal(after.releveled, 1);
});

test('grassetto e corsivo nel titolo non impediscono l’aggancio', () => {
  const roles = [{ role: 'heading', level: 1, text: 'Conclusioni' }];
  const after = applyRolesToMarkdown('## **Conclusioni**', roles);
  assert.equal(after.releveled, 1);
  assert.match(after.markdown, /^# \*\*Conclusioni\*\*$/);
});

test('i ruoli riportano la pagina di provenienza', () => {
  const { roles } = assignRoles(damagedBook());
  const chapter = roles.find((r) => r.role === 'heading' && r.level === 1);
  assert.ok(chapter.page >= 2, `capitolo a pagina ${chapter.page}`);
  assert.ok(chapter.bbox, 'il riquadro resta disponibile per gli usi futuri');
});
