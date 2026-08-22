import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTextSelection, replaceTextSelection } from '../src/lib/selectionRevision.js';

test('la selezione canonica rifinisce gli spazi e mantiene offset esatti', () => {
  const source = 'Prima frase.   Seconda frase completa.  Terza.';
  const selected = normalizeTextSelection(source, 13, 40);
  assert.equal(selected.ok, true);
  assert.equal(selected.text, 'Seconda frase completa.');
  assert.equal(
    replaceTextSelection(source, selected, 'Seconda frase corretta.'),
    'Prima frase.   Seconda frase corretta.  Terza.',
  );
});

test('blocca selezioni troncate dentro una parola o eccessivamente lunghe', () => {
  assert.equal(normalizeTextSelection('Una parola completa.', 5, 10).ok, false);
  assert.equal(normalizeTextSelection('x '.repeat(100), 0, 100, 20).ok, false);
});
