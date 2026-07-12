import test from 'node:test';
import assert from 'node:assert/strict';
import { markTypstSearchMatch, SEARCH_HIGHLIGHT_COLOR } from '../src/lib/searchPreview.js';

test('evidenzia soltanto la specifica occorrenza scelta', () => {
  const source = 'Prima parola e seconda parola.';
  const start = source.lastIndexOf('parola');
  const marked = markTypstSearchMatch(source, start, start + 'parola'.length);
  assert.equal((marked.match(/#highlight/g) || []).length, 1);
  assert.match(marked, new RegExp(SEARCH_HIGHLIGHT_COLOR.replace('#', '\\#')));
  assert.match(marked, /seconda #highlight[^\n]+\[parola\]\./);
});

test('non inserisce markup se la selezione tocca sintassi Typst', () => {
  const source = '#set text(font: "PT Serif")\nTesto visibile.';
  assert.equal(markTypstSearchMatch(source, 0, 4), source);
});
