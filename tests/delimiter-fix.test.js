import test from 'node:test';
import assert from 'node:assert/strict';
import { delimiterRepairCandidates } from '../src/lib/typstfix.js';

test('propone la chiusura della quadra nel solo blocco localizzato', () => {
  const source = '#set text(size: 11pt)\n\nPrima frase.\n\n#emph[Testo non chiuso\n\nUltimo blocco.';
  const candidates = delimiterRepairCandidates(source, 5);
  assert.ok(candidates.some((candidate) => candidate.fixed.includes('#emph[Testo non chiuso]\n\nUltimo')));
  assert.ok(candidates.every((candidate) => candidate.fixed.includes('Ultimo blocco.')));
});

test('rende esplicita l’enfasi senza cambiare le parole', () => {
  const source = 'Per _circolarità_ intendiamo la capacità del terapeuta.';
  const candidates = delimiterRepairCandidates(source, 1);
  const explicit = candidates.find((candidate) => candidate.description.includes('enfasi resa esplicita'));
  assert.ok(explicit);
  assert.equal(explicit.fixed, 'Per #emph[circolarità] intendiamo la capacità del terapeuta.');
});

test('propone sia chiusura sia protezione per un delimitatore inline isolato', () => {
  const source = 'Un testo con _enfasi non chiusa.';
  const candidates = delimiterRepairCandidates(source, 1);
  assert.ok(candidates.some((candidate) => candidate.fixed.endsWith('._')));
  assert.ok(candidates.some((candidate) => candidate.fixed.includes('con \\_enfasi')));
});
