import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assemblePage,
  footnoteMarkdown,
  headingMarkdown,
  isPageFurniture,
  pageFurnitureBlocks,
} from '../src/lib/assemble.js';

test('riconosce i numeri pagina anche dentro l’ampio margine inferiore', () => {
  assert.equal(isPageFurniture({
    type: 'Text',
    text: '19',
    bbox: { xmin: 0.48, xmax: 0.52, ymin: 0.86, ymax: 0.89 },
  }), true);
  assert.equal(isPageFurniture({
    type: 'Page-number',
    text: 'XIX',
    bbox: { xmin: 0.48, xmax: 0.52, ymin: 0.84, ymax: 0.88 },
  }), true);
});

test('scarta una testatina alta soltanto quando è associata al numero pagina', () => {
  const header = {
    type: 'Text',
    text: 'Ipotizzazione Circolarità Neutralità',
    bbox: { xmin: 0.05, xmax: 0.38, ymin: 0.14, ymax: 0.18 },
  };
  const pageNumber = {
    type: 'Text',
    text: '11',
    bbox: { xmin: 0.87, xmax: 0.91, ymin: 0.14, ymax: 0.18 },
  };
  const body = {
    type: 'Text',
    text: 'giore precisione il disordine, torniamo alla definizione.',
    bbox: { xmin: 0.06, xmax: 0.9, ymin: 0.28, ymax: 0.38 },
  };
  const furniture = pageFurnitureBlocks([header, pageNumber, body]);
  assert.equal(furniture.has(header), true);
  assert.equal(furniture.has(pageNumber), true);
  assert.equal(furniture.has(body), false);
  assert.equal(pageFurnitureBlocks([header, body]).has(header), false);
});

test('conserva i veri titoli e produce livelli Markdown', () => {
  const title = { type: 'Title', text: 'Titolo del libro' };
  const section = { type: 'Section-header', text: '2.3 Metodo' };
  assert.equal(headingMarkdown(title), '# Titolo del libro');
  assert.equal(headingMarkdown(section), '## 2.3 Metodo');
  const pageNumber = { type: 'Text', text: '11', bbox: { xmin: 0.9, xmax: 0.94, ymin: 0.1, ymax: 0.14 } };
  const trueHeading = { ...section, bbox: { xmin: 0.1, xmax: 0.6, ymin: 0.1, ymax: 0.16 } };
  assert.equal(pageFurnitureBlocks([pageNumber, trueHeading]).has(trueHeading), false);
});

test('aggancia le footnote al testo invece di inserirle come paragrafi', async () => {
  const blocks = [
    {
      type: 'Text',
      text: 'Dopo alcuni anni siamo pervenuti a stabilire alcuni principi.',
      bbox: { xmin: 0.1, xmax: 0.9, ymin: 0.45, ymax: 0.62 },
    },
    {
      type: 'Footnote',
      text: '* Componenti l’équipe di ricerca.\n— Trad. inglese in _Family Process_.',
      bbox: { xmin: 0.1, xmax: 0.9, ymin: 0.82, ymax: 0.9 },
    },
  ];
  const page = await assemblePage(blocks, '', { next: () => 1 });
  assert.equal(
    page.markdown,
    'Dopo alcuni anni siamo pervenuti a stabilire alcuni principi. ' +
      '<footnote>Componenti l’équipe di ricerca. — Trad. inglese in _Family Process_.</footnote>',
  );
  assert.equal(footnoteMarkdown('* Nota originale.'), '<footnote>Nota originale.</footnote>');
});

test('non scarta una footnote OCR classificata genericamente come Text', async () => {
  const note = {
    type: 'Text',
    text: '* Componenti l’équipe di ricerca del Centro per lo Studio della Famiglia.',
    bbox: { xmin: 0.08, xmax: 0.9, ymin: 0.84, ymax: 0.9 },
  };
  assert.equal(isPageFurniture(note), false);
  const page = await assemblePage([
    { type: 'Text', text: 'Testo principale.', bbox: { xmin: 0.1, xmax: 0.8, ymin: 0.4, ymax: 0.5 } },
    note,
    {
      type: 'Text',
      text: '— Trad. inglese in _Family Process_, vol. 1.',
      bbox: { xmin: 0.08, xmax: 0.7, ymin: 0.91, ymax: 0.94 },
    },
  ], '', { next: () => 1 });
  assert.match(page.markdown, /Testo principale\. <footnote>Componenti l’équipe/);
  assert.equal((page.markdown.match(/<footnote>/g) || []).length, 1);
  assert.match(page.markdown, /Famiglia\. — Trad\. inglese/);
});

test('non scarta numeri che fanno parte del contenuto', () => {
  assert.equal(isPageFurniture({
    type: 'Text',
    text: '19 pazienti completarono lo studio',
    bbox: { xmin: 0.1, xmax: 0.7, ymin: 0.84, ymax: 0.89 },
  }), false);
  assert.equal(isPageFurniture({
    type: 'Text',
    text: '1985',
    bbox: { xmin: 0.4, xmax: 0.6, ymin: 0.4, ymax: 0.45 },
  }), false);
  assert.equal(isPageFurniture({
    type: 'Text',
    text: 'i',
    bbox: { xmin: 0.4, xmax: 0.6, ymin: 0.86, ymax: 0.9 },
  }), false);
});
