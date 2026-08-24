import test from 'node:test';
import assert from 'node:assert/strict';

/*
  Il dizionario personale vive in localStorage: qui se ne simula uno, così le
  regole di import/export si possono verificare senza browser.
*/
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

const {
  loadSpellIgnore,
  addSpellIgnore,
  removeSpellIgnore,
  exportSpellIgnore,
  importSpellIgnore,
} = await import('../src/lib/storage.js');

test.beforeEach(() => store.clear());

test('le parole aggiunte restano, in minuscolo e senza doppioni', () => {
  addSpellIgnore(['Bateson', 'bateson', ' Selvini ']);
  assert.deepEqual(loadSpellIgnore().sort(), ['bateson', 'selvini']);
});

test('removeSpellIgnore toglie solo quello che gli si chiede', () => {
  addSpellIgnore(['bateson', 'selvini', 'haley']);
  removeSpellIgnore(['Selvini']);
  assert.deepEqual(loadSpellIgnore().sort(), ['bateson', 'haley']);
});

test('l’esportazione è un testo leggibile, una parola per riga e in ordine', () => {
  addSpellIgnore(['selvini', 'bateson']);
  const text = exportSpellIgnore();
  const lines = text.trim().split('\n');
  assert.match(lines[0], /^# Dizionario personale ScanConverter — 2 parole$/);
  assert.deepEqual(lines.slice(1), ['bateson', 'selvini']);
});

test('esportare e reimportare non cambia niente', () => {
  addSpellIgnore(['bateson', 'selvini']);
  const text = exportSpellIgnore();
  store.clear();
  const esito = importSpellIgnore(text);
  assert.equal(esito.added, 2);
  assert.deepEqual(loadSpellIgnore().sort(), ['bateson', 'selvini']);
});

test('l’importazione si unisce al dizionario esistente e conta solo il nuovo', () => {
  addSpellIgnore(['bateson']);
  const esito = importSpellIgnore('bateson\nhaley\nminuchin\n');
  assert.equal(esito.added, 2);
  assert.equal(esito.total, 3);
});

test('l’importazione può sostituire il dizionario invece di unirlo', () => {
  addSpellIgnore(['vecchia', 'altra']);
  importSpellIgnore('nuova\n', { replace: true });
  assert.deepEqual(loadSpellIgnore(), ['nuova']);
});

test('l’importazione ignora commenti e righe vuote', () => {
  const esito = importSpellIgnore('# intestazione\n\n  bateson  \n\n# altra nota\nhaley\n');
  assert.deepEqual(esito.words.sort(), ['bateson', 'haley']);
});

test('l’importazione accetta anche un semplice elenco JSON', () => {
  const esito = importSpellIgnore('["Bateson", "Haley"]');
  assert.deepEqual(esito.words.sort(), ['bateson', 'haley']);
});

test('un file senza parole viene rifiutato, invece di svuotare il dizionario', () => {
  addSpellIgnore(['bateson']);
  assert.throws(() => importSpellIgnore('# solo commenti\n\n'), /Nessuna parola/);
  assert.deepEqual(loadSpellIgnore(), ['bateson']);
});
