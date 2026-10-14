import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOcrBullets, fixTypstBullets } from '../src/lib/bullets.js';
import { autofixTypst } from '../src/lib/typstfix.js';

test('OCR: i pallini LaTeX diventano voci d’elenco', () => {
  assert.equal(normalizeOcrBullets('\\(\\bullet\\) «Uno.»\n$\\bullet$ Due\n• Tre'), '- «Uno.»\n- Due\n- Tre');
  assert.equal(normalizeOcrBullets('Un testo con \\bullet in mezzo'), 'Un testo con \\bullet in mezzo');
});

test('Typst: il caso reale segnalato', () => {
  const src = [
    '#block(inset: (left: 1em), stroke: (left: 0.5pt + luma(170)))[#text(style: "italic")[\\\\(\\\\bullet\\\\) "Se sono preso."]]',
    '',
    '\\\\(\\\\bullet\\\\) "Diventa difficile quando non capisco."',
  ].join('\n');
  const { code, count } = fixTypstBullets(src);
  assert.equal(count, 2);
  assert.match(code, /\[#text\(style: "italic"\)\[• "Se sono preso\."\]\]/);
  assert.match(code, /^- "Diventa difficile/m);
  assert.doesNotMatch(code, /bullet/);
});

test('Typst: anche con un solo backslash', () => {
  assert.equal(fixTypstBullets('\\(\\bullet\\) voce').code, '- voce');
});

test('la correzione locale li sistema', () => {
  const res = autofixTypst('\\\\(\\\\bullet\\\\) voce');
  assert.equal(res.fixed, '- voce');
});
