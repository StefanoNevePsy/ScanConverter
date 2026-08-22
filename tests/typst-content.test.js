import test from 'node:test';
import assert from 'node:assert/strict';
import {
  typstDocumentPassages,
  typstPlainText,
  typstVisibleText,
} from '../src/lib/typstContent.js';

test('estrae soltanto il contenuto modificabile e conserva gli offset Typst', () => {
  const source = [
    '#set page(width: 210mm, margin: 20mm)',
    '#show heading: set text(weight: "bold")',
    '// pagina 12',
    '= Invisible loyalties',
    '',
    'The family is connected by #emph[loyalty] and obligation.',
    '',
    '#pagebreak()',
  ].join('\n\n');
  const passages = typstDocumentPassages(source);
  assert.equal(passages.length, 2);
  assert.deepEqual(passages.map((item) => item.page), [12, 12]);
  assert.equal(passages[0].kind, 'heading');
  assert.equal(passages[0].text, 'Invisible loyalties');
  for (const passage of passages) {
    assert.equal(source.slice(passage.start, passage.end), passage.text);
  }
  assert.equal(typstVisibleText(passages[1].text), 'The family is connected by loyalty and obligation.');
});

test('il testo PDF atteso nasce dal Typst e non include il preambolo', () => {
  const source = '#set text(lang: "it")\n\n= Titolo corretto\n\nTesto modificato a mano.';
  const plain = typstPlainText(source);
  assert.match(plain, /Titolo corretto/);
  assert.match(plain, /Testo modificato a mano/);
  assert.doesNotMatch(plain, /lang|text/);
});

test('non confonde le opzioni di stile Typst con testo stampato', () => {
  const source = '#text(spacing: 0.45em, weight: "bold")[On the family system]';
  assert.equal(typstVisibleText(source), 'On the family system');
});
