import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mapEditorSelectionToCanonical,
  normalizeTextSelection,
  replaceTextSelection,
} from '../src/lib/selectionRevision.js';

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

test('riconduce una selezione Typst alla stessa prosa canonica', () => {
  const canonical = 'Prima frase.\n\nIl testo con un simbolo # resta modificabile.\n\nUltima frase.';
  const editorCode = '#set page(width: 210mm)\n\nPrima frase.\n\nIl testo con un simbolo \\# resta modificabile.\n\nUltima frase.';
  const selectedText = 'Il testo con un simbolo \\# resta modificabile.';
  const start = editorCode.indexOf(selectedText);
  const mapped = mapEditorSelectionToCanonical({
    canonical,
    editorCode,
    start,
    end: start + selectedText.length,
  });
  assert.equal(mapped.ok, true);
  assert.equal(mapped.text, 'Il testo con un simbolo # resta modificabile.');
});

test('rifiuta una selezione del preambolo Typst', () => {
  const editorCode = '#set page(width: 210mm)\n\nTesto.';
  const mapped = mapEditorSelectionToCanonical({
    canonical: 'Testo.',
    editorCode,
    start: 0,
    end: editorCode.indexOf('\n\n'),
  });
  assert.equal(mapped.ok, false);
  assert.match(mapped.message, /comandi Typst/);
});

test('non confonde una frase con la stessa sequenza dentro una parola più lunga', () => {
  const canonical = 'In contrasto con il primo caso.\n\nIn contrast, this English passage must be translated.';
  const editorCode = '#set text(lang: "it")\n\nIn contrasto con il primo caso.\n\nIn contrast, this English passage must be translated.';
  const start = editorCode.lastIndexOf('In contrast');
  const mapped = mapEditorSelectionToCanonical({
    canonical,
    editorCode,
    start,
    end: start + 'In contrast'.length,
  });
  assert.equal(mapped.ok, true);
  assert.equal(mapped.start, canonical.lastIndexOf('In contrast'));
});
