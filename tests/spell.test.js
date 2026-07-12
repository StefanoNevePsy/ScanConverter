import test from 'node:test';
import assert from 'node:assert/strict';
import { fixOcrHyphenation, fixSpacing } from '../src/lib/spell.js';

test('rimuove gli spazi interni alle virgolette italiane e OCR', () => {
  const source = 'Disse: « richiamo » e poi << prova >>. Anche “ testo ”.';
  const { fixed, changes } = fixSpacing(source);
  assert.equal(fixed, 'Disse: «richiamo» e poi <<prova>>. Anche “testo”.');
  assert.ok(changes.some((change) => change.includes('virgolette aperte')));
  assert.ok(changes.some((change) => change.includes('virgolette chiuse')));
});

test('non altera gli spazi esterni alle virgolette', () => {
  assert.equal(fixSpacing('prima « testo » dopo').fixed, 'prima «testo» dopo');
});

test('il correttore locale ricompone le sillabazioni note anche nel Typst esistente', () => {
  const known = new Set(['ipotesi', 'qualche', 'conformemente']);
  const speller = { correct: (word) => known.has(word.toLowerCase()) };
  const source = '#set text(lang: "it")\n\nUn’ipo - tesi in qual - che modo, con - formemente al testo.';
  const { fixed, changes } = fixOcrHyphenation(source, speller);
  assert.equal(
    fixed,
    '#set text(lang: "it")\n\nUn’ipotesi in qualche modo, conformemente al testo.',
  );
  assert.equal(changes.length, 3);
});
