import test from 'node:test';
import assert from 'node:assert/strict';

import { estimatePdfPage, pageSearchOrder, cursorSearchText } from '../src/lib/pdfPreview.js';

test('la stima copre tutto l’intervallo, dalla prima all’ultima pagina', () => {
  assert.equal(estimatePdfPage(0, 100), 1);
  assert.equal(estimatePdfPage(1, 100), 100);
  assert.equal(estimatePdfPage(0.5, 101), 51);
  assert.equal(estimatePdfPage(0.25, 5), 2);
});

test('la stima regge documenti degeneri', () => {
  assert.equal(estimatePdfPage(0.5, 0), 0);
  assert.equal(estimatePdfPage(0.5, 1), 1);
  assert.equal(estimatePdfPage(-3, 10), 1);
  assert.equal(estimatePdfPage(9, 10), 10);
});

test('le pagine si guardano dalla stima verso l’esterno', () => {
  assert.deepEqual(pageSearchOrder(10, 100, 2), [10, 11, 9, 12, 8]);
});

test('l’ordine non esce dai bordi del documento', () => {
  assert.deepEqual(pageSearchOrder(1, 3, 3), [1, 2, 3]);
  assert.deepEqual(pageSearchOrder(3, 3, 2), [3, 2, 1]);
  assert.deepEqual(pageSearchOrder(1, 0), []);
});

test('il frammento del cursore è la riga di prosa, senza marcatura', () => {
  const source = 'Prima riga.\nIl terapeuta osserva la _sequenza_ e ne registra il ritmo.\nAltra riga.';
  const at = source.indexOf('osserva');
  assert.equal(
    cursorSearchText(source, at),
    'Il terapeuta osserva la sequenza e ne registra il ritmo.',
  );
});

test('il frammento si ferma alla lunghezza chiesta', () => {
  const source = 'x'.repeat(5) + ' parole lunghe ' + 'y'.repeat(200);
  assert.equal(cursorSearchText(source, 3).length <= 60, true);
});

test('righe che nel PDF non esistono non producono ricerche', () => {
  assert.equal(cursorSearchText('= Titolo del capitolo qui', 4), '');
  assert.equal(cursorSearchText('#set page(paper: "a4", margin: 2cm)', 5), '');
  assert.equal(cursorSearchText('// pagina 12', 4), '');
  assert.equal(cursorSearchText('breve', 2), '');
  assert.equal(cursorSearchText('', 0), '');
});
