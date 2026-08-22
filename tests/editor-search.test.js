import test from 'node:test';
import assert from 'node:assert/strict';
import { findBestEditorLocation, findEditorMatches } from '../src/lib/editorScroll.js';

test('la ricerca spellchecker non trova entre dentro Mentre', () => {
  const source = 'Mentre il testo continua. Sur l’Equivalence entre Information.';
  assert.deepEqual(findEditorMatches(source, 'entre', true), [44]);
  assert.deepEqual(findEditorMatches(source, 'entre', false), [1, 44]);
});

test('i confini della ricerca per parola intera sono Unicode', () => {
  const source = 'capacità capacita capacitàdel capacità';
  assert.deepEqual(findEditorMatches(source, 'capacità', true), [0, 30]);
});

test('localizza nel Typst un passaggio Markdown anche con markup diverso', () => {
  const editor = '= Capitolo\n\nLa _famiglia_ resta legata da obblighi reciproci.';
  const heading = findBestEditorLocation(editor, '# Capitolo', 0);
  const paragraph = findBestEditorLocation(
    editor,
    'La <footnote>famiglia</footnote> resta legata da obblighi reciproci.',
    0.8,
  );
  assert.equal(heading.query, 'Capitolo');
  assert.match(editor.slice(paragraph.start, paragraph.end), /resta legata/);
  assert.match(paragraph.query, /^[\p{L}\p{M}\p{N}'’\-\s]+$/u);
});

test('usa la posizione approssimativa per scegliere un duplicato', () => {
  const repeated = 'Passaggio identico abbastanza lungo da essere localizzato.';
  const editor = `${repeated}\n\nTesto intermedio.\n\n${repeated}`;
  const location = findBestEditorLocation(editor, repeated, 0.9);
  assert.equal(location.occurrence, 1);
  assert.equal(location.start, editor.lastIndexOf(repeated));
});
