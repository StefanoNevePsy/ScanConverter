import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applySpellFixes,
  findSuspects,
  fixOcrHyphenation,
  fixSpacing,
  suggestOcrWordRepair,
  validateCorrections,
} from '../src/lib/spell.js';

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
  const known = new Set([
    'ipotesi', 'qualche', 'conformemente', 'sostanzialmente', 'mente',
    'attivo', 'modificata', 'designare', 'socio', 'politico', 'sociopolitico',
    'inaspettato', 'ina', 'spettato', 'nostra', 'no', 'stra',
    'nord', 'est', 'nordest',
  ]);
  const speller = { correct: (word) => known.has(word.toLowerCase()) };
  const source =
    '#set text(lang: "it")\n\nUn’ipo - tesi sostanzial-mente at-tivo ' +
    'mo-modificata ina-spettato no-stra, da desi gnare; socio-politico nord-est.';
  const { fixed, changes } = fixOcrHyphenation(source, speller);
  assert.equal(
    fixed,
    '#set text(lang: "it")\n\nUn’ipotesi sostanzialmente attivo ' +
      'modificata inaspettato nostra, da designare; socio-politico nord-est.',
  );
  assert.equal(changes.length, 7);
  assert.equal(suggestOcrWordRepair('socio', '-', 'politico', speller), '');
});

test('lo spellchecker segnala una parola spezzata come sequenza unica', () => {
  const known = new Set(['comportamento']);
  const speller = { correct: (word) => known.has(word.toLowerCase()) };
  const suspects = findSuspects('Il comparta-mento osservato.', speller);
  assert.ok(suspects.some((item) => item.word === 'comparta-mento'));
  assert.ok(!suspects.some((item) => item.word === 'comparta' || item.word === 'mento'));
});

test('la correzione AI può sostituire l’intera sequenza spezzata', () => {
  const speller = { correct: (word) => word.toLowerCase() === 'comportamento' };
  const proposal = [{ word: 'comparta - mento', fix: 'comportamento' }];
  const validated = validateCorrections(proposal, speller, new Set(['comparta - mento']));
  assert.deepEqual(validated.ok, proposal);
  const applied = applySpellFixes('Il comparta - mento osservato.', validated.ok);
  assert.equal(applied.code, 'Il comportamento osservato.');
  assert.equal(applied.applied[0].count, 1);
});
