import test from 'node:test';
import assert from 'node:assert/strict';
import {
  choosePdfSearchPage,
  countPdfTextOccurrences,
  createPdfSearchTarget,
  normalizePdfSearchText,
} from '../src/lib/pdfPreview.js';

test('normalizza spazi e varianti Unicode per la ricerca nel PDF', () => {
  assert.equal(normalizePdfSearchText('  Caffè\n  SOCIETÀ  '), 'caffè società');
});

test('conta le occorrenze senza sovrapporle', () => {
  assert.equal(countPdfTextOccurrences('uno due uno DUE uno', 'uno'), 3);
  assert.equal(countPdfTextOccurrences('aaaa', 'aa'), 2);
});

test('sceglie la pagina dell’occorrenza e ricade sulla prima corrispondenza', () => {
  assert.equal(choosePdfSearchPage([0, 2, 0, 1], 0), 1);
  assert.equal(choosePdfSearchPage([0, 2, 0, 1], 2), 3);
  assert.equal(choosePdfSearchPage([0, 2, 0, 1], 99), 1);
  assert.equal(choosePdfSearchPage([0, 0], 0), -1);
});

test('crea un target soltanto da testo visibile selezionato', () => {
  const source = 'Parola e ancora Parola.\n#set text(size: 10pt)';
  const start = source.lastIndexOf('Parola');
  assert.deepEqual(
    createPdfSearchTarget(source, { id: 7, start, end: start + 6 }),
    { id: 7, text: 'Parola', normalized: 'parola', occurrence: 1 },
  );
  assert.equal(createPdfSearchTarget(source, { id: 8, start: source.indexOf('#'), end: source.length }), null);
});
