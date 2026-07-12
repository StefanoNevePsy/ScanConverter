import test from 'node:test';
import assert from 'node:assert/strict';
import { findEditorMatches } from '../src/lib/editorScroll.js';

test('la ricerca spellchecker non trova entre dentro Mentre', () => {
  const source = 'Mentre il testo continua. Sur l’Equivalence entre Information.';
  assert.deepEqual(findEditorMatches(source, 'entre', true), [44]);
  assert.deepEqual(findEditorMatches(source, 'entre', false), [1, 44]);
});

test('i confini della ricerca per parola intera sono Unicode', () => {
  const source = 'capacità capacita capacitàdel capacità';
  assert.deepEqual(findEditorMatches(source, 'capacità', true), [0, 30]);
});
