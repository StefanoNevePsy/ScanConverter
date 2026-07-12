import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applySpellFixes,
  createSpeller,
  findSuspects,
  fixOcrHyphenation,
  fixSpacing,
  normalizeSoftHyphens,
  suggestFusedWordRepair,
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

test('usa una grafia corretta già presente per ricomporre i nomi propri', () => {
  const speller = { correct: () => false };
  const suspects = findSuspects('Milano, Fel - trinelli, 1978. Milano, Feltrinelli, 1975.', speller);
  const split = suspects.find((item) => item.word === 'Fel - trinelli');
  assert.equal(split?.suggestedFix, 'Feltrinelli');
  const validated = validateCorrections(
    [{ word: split.word, fix: split.suggestedFix }],
    speller,
    new Set([split.word]),
    new Set(['feltrinelli']),
  );
  assert.equal(validated.ok[0].fix, 'Feltrinelli');
});

test('consente all’AI di separare parole fuse senza riscriverle', () => {
  const known = new Set(['contare', 'che', 'capacità', 'del']);
  const speller = { correct: (word) => known.has(word.toLowerCase()) };
  const proposals = [
    { word: 'contareche', fix: 'contare che' },
    { word: 'capacitatdel', fix: 'capacità del' },
    { word: 'parolafalsa', fix: 'testo inventato' },
  ];
  const validated = validateCorrections(
    proposals,
    speller,
    new Set(proposals.map((item) => item.word)),
  );
  assert.deepEqual(validated.ok, proposals.slice(0, 2));
  assert.deepEqual(validated.rejected, proposals.slice(2));
});

test('separa localmente le parole-funzione fuse quando entrambe le parti sono note', () => {
  const known = new Set([
    'contare', 'che', 'accada', 'una', 'rapporti', 'sempre', 'stato', 'qualche',
  ]);
  const speller = { correct: (word) => known.has(word.toLowerCase()) };
  assert.equal(suggestFusedWordRepair('contareche', speller), 'contare che');
  assert.equal(suggestFusedWordRepair('accadauna', speller), 'accada una');
  assert.equal(suggestFusedWordRepair('rapportiche', speller), 'rapporti che');
  assert.equal(suggestFusedWordRepair('semprestato', speller), 'sempre stato');
  assert.equal(suggestFusedWordRepair('qualche', speller), '');
  const repaired = fixOcrHyphenation(
    'Senza contareche accadauna cosa nei rapportiche è semprestato chiaro.',
    speller,
  );
  assert.equal(
    repaired.fixed,
    'Senza contare che accada una cosa nei rapporti che è sempre stato chiaro.',
  );
});

test('una parola già corretta non lascia frammenti obsoleti nel nuovo report', () => {
  const known = new Set(['vacanze', 'contare', 'che', 'accada', 'una', 'rapporti', 'sempre', 'stato']);
  const speller = { correct: (word) => known.has(word.toLowerCase()) };
  const suspects = findSuspects(
    'vacanze contare che accada una cosa nei rapporti che è sempre stato chiaro',
    speller,
  );
  assert.ok(!suspects.some((item) => item.word === 'canze'));
  assert.ok(!suspects.some((item) => ['are che', 'cada una', 'orti che', 'pre stato'].includes(item.word)));
});

test('riconosce le forme verbali con pronome enclitico mancanti dalla lista', () => {
  const speller = createSpeller({ itWords: 'indicando\nsuggerita\nproposto', enWords: '' });
  assert.equal(speller.correct('indicandoli'), true);
  assert.equal(speller.correct('suggeritagli'), true);
  assert.equal(speller.correct('propostoci'), true);
});

test('non segnala metà parola quando l’enfasi Typst divide le lettere', () => {
  const speller = createSpeller({ itWords: 'mentre', enWords: '' });
  const suspects = findSuspects('*M*entre il testo continua.', speller);
  assert.ok(!suspects.some((item) => item.word.toLowerCase() === 'entre'));
});

test('ricompone una sillabazione che attraversa un newline nel Typst esistente', () => {
  const speller = createSpeller({ itWords: 'indicando', enWords: '' });
  const repaired = fixOcrHyphenation('principi, indi -\ncandoli con attenzione', speller);
  assert.equal(repaired.fixed, 'principi, indicandoli con attenzione');
});

test('normalizza i soft-hyphen invisibili senza lasciare frammenti', () => {
  const source =
    'va\u00ADcanze Fran\u00ADcesca infor\u00ADmazione pro\u00ADvocati ' +
    'rela\u00ADrelazione quantità\u00ADquantità speciale\u00ADle';
  assert.equal(
    normalizeSoftHyphens(source),
    'vacanze Francesca informazione provocati relazione quantità speciale',
  );
  const speller = createSpeller({
    itWords: 'vacanze\nfrancesca\ninformazione\nprovocati\nrelazione\nquantità\nspeciale',
    enWords: '',
  });
  const repaired = fixOcrHyphenation(source, speller);
  assert.equal(repaired.fixed, normalizeSoftHyphens(source));
  assert.equal(repaired.changes.length, 7);
  assert.equal(findSuspects(repaired.fixed, speller).length, 0);
});
