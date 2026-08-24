import test from 'node:test';
import assert from 'node:assert/strict';

import { matchCase, replaceOccurrence, replaceAllPreservingCase } from '../src/lib/replaceCase.js';

test('matchCase riporta il taglio di maiuscole dell’occorrenza trovata', () => {
  assert.equal(matchCase('perche', 'perché'), 'perché');
  assert.equal(matchCase('Perche', 'perché'), 'Perché');
  assert.equal(matchCase('PERCHE', 'perché'), 'PERCHÉ');
});

test('matchCase non reinterpreta un caso misto', () => {
  // «McLuhan» non deve diventare «Mcluhan»: quello che scrive l’utente vale.
  assert.equal(matchCase('mcluhan', 'McLuhan'), 'McLuhan');
  // Un campione a caso misto lascia intatta la forma scritta dall’utente…
  assert.equal(matchCase('BoszormenyiNagy', 'Boszormenyi-Nagy'), 'Boszormenyi-Nagy');
  // …mentre uno tutto maiuscolo la porta in maiuscolo.
  assert.equal(matchCase('BOSZORMENYI', 'Boszormenyi-Nagy'), 'BOSZORMENYI-NAGY');
});

test('matchCase tratta una sola lettera maiuscola come iniziale, non come tutto maiuscolo', () => {
  assert.equal(matchCase('E', 'è'), 'È');
});

test('matchCase salta i segni iniziali per trovare la prima lettera', () => {
  assert.equal(matchCase('«Perche', '«perché'), '«Perché');
});

test('matchCase lascia stare ciò che non ha lettere', () => {
  assert.equal(matchCase('123', '456'), '456');
  assert.equal(matchCase('perche', ''), '');
});

test('replaceOccurrence corregge un punto solo conservandone il caso', () => {
  const text = 'Perche no? Perche sì.';
  const once = replaceOccurrence(text, 0, 6, 'perché');
  assert.equal(once, 'Perché no? Perche sì.');
});

test('replaceAllPreservingCase corregge ogni forma con la sua maiuscola', () => {
  const text = 'perche, Perche e PERCHE nella stessa riga.';
  const { value, count } = replaceAllPreservingCase(text, 'perche', 'perché');
  assert.equal(value, 'perché, Perché e PERCHÉ nella stessa riga.');
  assert.equal(count, 3);
});

test('replaceAllPreservingCase trova anche se l’utente scrive in maiuscolo', () => {
  const text = 'perche e Perche';
  const { value } = replaceAllPreservingCase(text, 'PERCHE', 'perché');
  assert.equal(value, 'perché e Perché');
});

test('replaceAllPreservingCase rispetta la parola intera quando richiesto', () => {
  const text = 'la casa e la casalinga';
  const parziale = replaceAllPreservingCase(text, 'casa', 'cascina');
  assert.equal(parziale.count, 2);
  const intera = replaceAllPreservingCase(text, 'casa', 'cascina', { wholeWord: true });
  assert.equal(intera.value, 'la cascina e la casalinga');
  assert.equal(intera.count, 1);
});

test('replaceAllPreservingCase gestisce una sostituzione più lunga senza sfasare gli offset', () => {
  const text = 'ab ab ab';
  const { value, count } = replaceAllPreservingCase(text, 'ab', 'abcdef');
  assert.equal(value, 'abcdef abcdef abcdef');
  assert.equal(count, 3);
});

test('replaceAllPreservingCase non tocca niente se la parola non c’è', () => {
  const text = 'testo qualunque';
  assert.deepEqual(replaceAllPreservingCase(text, 'zebrone', 'x'), { value: text, count: 0 });
  assert.deepEqual(replaceAllPreservingCase(text, '', 'x'), { value: text, count: 0 });
});

test('replaceAllPreservingCase permette di cancellare la parola', () => {
  const { value, count } = replaceAllPreservingCase('uno due due tre', 'due ', '');
  assert.equal(value, 'uno tre');
  assert.equal(count, 2);
});
