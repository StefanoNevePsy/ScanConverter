import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isTableBlock,
  looksLikeMarkdownTable,
  stripFence,
  tableGuard,
  refinePageTables,
} from '../src/lib/segments.js';

const bbox = { xmin: 0.1, ymin: 0.2, xmax: 0.9, ymax: 0.5 };

test('riconosce solo i blocchi tabella con bounding box', () => {
  assert.equal(isTableBlock({ type: 'Table', bbox, text: 'x' }), true);
  assert.equal(isTableBlock({ type: 'Table', bbox: null, text: 'x' }), false);
  assert.equal(isTableBlock({ type: 'Text', bbox, text: 'x' }), false);
  assert.equal(isTableBlock(null), false);
});

test('rimuove il recinto di codice che il modello aggiunge comunque', () => {
  assert.equal(stripFence('```markdown\n| a | b |\n```'), '| a | b |');
  assert.equal(stripFence('| a | b |'), '| a | b |');
});

test('distingue una tabella con pipe da testo semplice', () => {
  assert.equal(looksLikeMarkdownTable('| a | b |\n| --- | --- |\n| 1 | 2 |'), true);
  assert.equal(looksLikeMarkdownTable('Solo una frase di prosa.'), false);
});

test('il guard accetta la ristrutturazione che conserva le celle', () => {
  const ocr = '\\begin{tabular}{ll} \\hline Anno & Casi \\\\ 1972 & 14 \\\\ \\end{tabular}';
  const refined = '| Anno | Casi |\n| --- | --- |\n| 1972 | 14 |';
  assert.equal(tableGuard(ocr, refined).ok, true);
});

test('il guard rifiuta i numeri inventati dal modello', () => {
  const ocr = '| Anno | Casi |\n| 1972 | 14 |';
  const refined = '| Anno | Casi |\n| --- | --- |\n| 1972 | 14 |\n| 1973 | 27 |';
  const res = tableGuard(ocr, refined);
  assert.equal(res.ok, false);
  assert.ok(res.added.includes('1973'));
});

test('il guard rifiuta la sparizione di gran parte della tabella', () => {
  const ocr = '| Anno | Casi | Note |\n| 1972 | 14 | primo |\n| 1973 | 27 | secondo |';
  const refined = '| Anno | Casi |\n| --- | --- |';
  assert.equal(tableGuard(ocr, refined).ok, false);
});

test('senza chiave Google i blocchi restano invariati', async () => {
  const blocks = [{ type: 'Table', bbox, text: 'originale' }];
  const res = await refinePageTables({
    blocks,
    pageDataUrl: 'data:image/png;base64,AAAA',
    settings: { googleApiKey: '' },
  });
  assert.equal(res.refined, 0);
  assert.equal(res.blocks[0].text, 'originale');
});

test('senza blocchi tabella non tocca nulla e non chiama la rete', async () => {
  const blocks = [{ type: 'Text', bbox, text: 'prosa' }];
  const res = await refinePageTables({
    blocks,
    pageDataUrl: 'data:image/png;base64,AAAA',
    settings: { googleApiKey: 'AIza-FAKE' },
  });
  assert.equal(res.refined, 0);
  assert.equal(res.blocks, blocks);
});
