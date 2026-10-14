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

import { markdownToStrictTypst } from '../src/lib/strict.js';

test('Fedeltà massima: citazioni con pallini → un elenco uniforme', () => {
  const md = [
    '### La voce del gruppo',
    '- «Se sono preso da cose mie.»',
    '- «Diventa difficile quando non capisco.»',
    '- «A volte quello che penso mi sembra importante.»',
  ].join('\n\n');
  const plan = { blocks: [{ id: 'b-2', style: 'quote' }, { id: 'b-4', style: 'quote' }] };
  const out = markdownToStrictTypst(md, plan);
  assert.doesNotMatch(out, /bullet/);
  assert.equal((out.match(/^- /gm) || []).length, 3);
  assert.doesNotMatch(out, /luma\(170\)/);
});

test('citazioni in prosa: lo stile della maggioranza vale per tutta la serie', () => {
  const md = ['«Uno.»', '«Due.»', '«Tre.»'].join('\n\n');
  const out = markdownToStrictTypst(md, { blocks: [{ id: 'b-1', style: 'quote' }, { id: 'b-3', style: 'quote' }] });
  assert.equal((out.match(/luma\(170\)/g) || []).length, 3);
});
