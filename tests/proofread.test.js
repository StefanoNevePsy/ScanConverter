import test from 'node:test';
import assert from 'node:assert/strict';
import { isSafeContextualCorrection } from '../src/lib/proofread.js';

const known = new Set([
  'accada', 'che', 'contare', 'difficile', 'era', 'formulo', 'formulò', 'giovane',
  'il', 'la', 'ragazzo', 'sempre', 'sarà', 'terapia', 'comportamento', 'è',
]);
const speller = { correct: (word) => known.has(word.toLocaleLowerCase('it')) };

test('accetta accenti e forme verbali equivalenti senza riscrivere', () => {
  assert.equal(isSafeContextualCorrection('Il terapista formulo.', 'Il terapista formulò.', speller), true);
});

test('accetta fusioni, separazioni e piccoli refusi OCR contestuali', () => {
  assert.equal(
    isSafeContextualCorrection('Il comparta-mento era difficile.', 'Il comportamento era difficile.', speller),
    true,
  );
  assert.equal(isSafeContextualCorrection('Senza contareche accada.', 'Senza contare che accada.', speller), true);
});

test('accetta soltanto inserzioni conservative di parole-funzione', () => {
  assert.equal(isSafeContextualCorrection('La terapia sempre difficile.', 'La terapia è sempre difficile.', speller), true);
});

test('rifiuta sinonimi, cambi semantici e cancellazioni', () => {
  assert.equal(isSafeContextualCorrection('Il ragazzo era difficile.', 'Il giovane era difficile.', speller), false);
  assert.equal(isSafeContextualCorrection('Il ragazzo era difficile.', 'Il ragazzo sarà difficile.', speller), false);
  assert.equal(isSafeContextualCorrection('Il ragazzo era difficile.', 'Il ragazzo era.', speller), false);
  assert.equal(isSafeContextualCorrection('Il ragazzo era difficile.', 'Il ragazzo era difficile!', speller), false);
});
