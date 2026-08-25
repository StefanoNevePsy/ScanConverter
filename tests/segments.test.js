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

test('il tetto sui file distingue immagini e PDF', async () => {
  const { validateFile, MAX_IMAGE_BYTES, MAX_PDF_BYTES } = await import('../src/lib/files.js');
  const finto = (type, size) => ({ type, size, name: 'x' });
  // Un'immagine grande va rifiutata: viene spedita intera al motore OCR.
  assert.match(validateFile(finto('image/png', MAX_IMAGE_BYTES + 1)), /Immagine troppo grande/);
  assert.equal(validateFile(finto('image/png', MAX_IMAGE_BYTES - 1)), null);
  // Un PDF da cento megabyte no: si legge pagina per pagina, non si spedisce.
  assert.equal(validateFile(finto('application/pdf', 100 * 1024 * 1024)), null);
  assert.match(validateFile(finto('application/pdf', MAX_PDF_BYTES + 1)), /PDF troppo grande/);
  assert.match(validateFile(finto('text/plain', 10)), /Formato non supportato/);
});

test('dividere una doppia pagina rinumera quelle che seguono', async () => {
  const { pageTargets } = await import('../src/lib/pagePrep.js');
  const { total, plan } = pageTargets(3, [{}, { split: true }, {}]);
  assert.equal(total, 4);
  // Si lavora dall'ultima verso la prima: ciò che si sovrascrive è già letto.
  assert.deepEqual(plan, [
    { index: 2, targets: [3] },
    { index: 1, targets: [1, 2] },
    { index: 0, targets: [0] },
  ]);
});

test('senza divisioni ogni pagina resta al suo posto', async () => {
  const { pageTargets } = await import('../src/lib/pagePrep.js');
  const { total, plan } = pageTargets(4, [{ rotate: 90 }, {}, {}, {}]);
  assert.equal(total, 4);
  assert.deepEqual(plan.map((p) => p.targets), [[3], [2], [1], [0]]);
});

test('nessuna destinazione può sovrascrivere una pagina non ancora letta', async () => {
  const { pageTargets } = await import('../src/lib/pagePrep.js');
  const edits = Array.from({ length: 30 }, (_, i) => ({ split: i % 3 === 0 }));
  const { plan } = pageTargets(30, edits);
  const lette = new Set();
  for (const { index, targets } of plan) {
    lette.add(index);
    for (const t of targets) {
      assert.equal(t >= index, true, `la pagina ${index} scrive in ${t}`);
      if (t !== index) assert.equal(lette.has(t) || t > index, true);
    }
  }
});
