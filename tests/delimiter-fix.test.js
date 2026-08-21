import test from 'node:test';
import assert from 'node:assert/strict';
import {
  autofixTypst,
  delimiterRepairCandidates,
  repairTypstDeterministically,
  typstRepairCandidates,
} from '../src/lib/typstfix.js';

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

test('corregge una parentesi di tipo sbagliato nel blocco localizzato', () => {
  const source = '#emph[Testo chiuso con la parentesi sbagliata)';
  const candidates = delimiterRepairCandidates(source, 1);
  assert.ok(candidates.some((candidate) => candidate.fixed === '#emph[Testo chiuso con la parentesi sbagliata]'));
});

test('ignora delimitatori dentro commenti, stringhe e blocchi raw', () => {
  const source = '#let x = "[testo"\n// parentesi [ ignorata\n`raw { ignorata`\nTesto valido.';
  const candidates = delimiterRepairCandidates(source, 4);
  assert.ok(candidates.every((candidate) => !candidate.description.includes('chiusi delimitatori')));
});

test('propone alias Typst noti in base alla diagnostica', () => {
  const source = 'Prima pagina.\n\n#newpage()\n\nSeconda pagina.';
  const candidates = typstRepairCandidates(source, {
    line: 3,
    message: 'unknown variable: newpage',
  });
  assert.ok(candidates.some((candidate) => candidate.fixed.includes('#pagebreak()')));
});

test('propone la conversione di HTML residuo nel solo blocco errato', () => {
  const source = 'Testo con <sup>12</sup> e <b>richiamo</b>.';
  const candidates = typstRepairCandidates(source, {
    line: 1,
    message: 'invalid label',
  });
  assert.ok(candidates.some((candidate) => candidate.fixed.includes('#super[12]')));
  assert.ok(candidates.some((candidate) => candidate.fixed.includes('#strong[richiamo]')));
});

test('normalizza il grassetto Markdown senza toccare il testo', () => {
  const repaired = autofixTypst('Parola **importante**.');
  assert.equal(repaired.fixed, 'Parola *importante*.');
  assert.equal(repaired.changes.length, 1);
  assert.equal(autofixTypst('#let __nome__ = 1').fixed, '#let __nome__ = 1');
});

test('il motore iterativo supera il vecchio limite di quattro errori', async () => {
  const source = Array.from({ length: 9 }, (_, i) => `Blocco ${i + 1}.\n#newpage()`).join('\n\n');
  const diagnose = async (code) => {
    const at = code.indexOf('#newpage()');
    if (at === -1) return { ok: true, diagnostics: [] };
    const line = code.slice(0, at).split('\n').length;
    return {
      ok: false,
      diagnostics: [{ severity: 'error', message: 'unknown variable: newpage', line }],
    };
  };
  const repaired = await repairTypstDeterministically({ source, diagnose });
  assert.equal(repaired.ok, true);
  assert.equal(repaired.rounds, 9);
  assert.doesNotMatch(repaired.fixed, /#newpage/);
  assert.equal((repaired.fixed.match(/#pagebreak/g) || []).length, 9);
});
