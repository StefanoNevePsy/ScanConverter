import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { figureRelativePath, shortDiagnostics } = require('../electron/typst-runner.cjs');

test('il motore nativo accetta soltanto figure confinate alla cartella dedicata', () => {
  assert.equal(figureRelativePath('/figures/fig-1.png'), path.join('figures', 'fig-1.png'));
  assert.throws(() => figureRelativePath('/figures/../segreto.txt'), /non sicuro/);
  assert.throws(() => figureRelativePath('/altro/fig.png'), /non valido/);
});

test('estrae le diagnostiche brevi Typst conservando path, riga e colonna', () => {
  const stderr = [
    String.raw`C:\progetto\main.typ:42:7: error: unknown variable: foo`,
    'messaggio di servizio non diagnostico',
    '/tmp/main.typ:9:2-9:5: warning: font mancante',
  ].join('\n');
  assert.deepEqual(shortDiagnostics(stderr), [
    String.raw`C:\progetto\main.typ:42:7: error: unknown variable: foo`,
    '/tmp/main.typ:9:2-9:5: warning: font mancante',
  ]);
});
