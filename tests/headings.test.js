import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveHeadingLevels, headingShape, markdownToStrictTypst } from '../src/lib/strict.js';

const run = (blocks, model) => resolveHeadingLevels(blocks, new Map(Object.entries(model)));

test('stessa forma → stesso livello, anche fuori dal campione del modello', () => {
  const blocks = ['## 1. Introduzione', 'testo', '## 2. Metodo', 'testo', '## 3. Risultati'];
  const levels = run(blocks, { 'b-1': 2, 'b-3': 2 });
  assert.equal(levels.get('b-5'), levels.get('b-1'));
});

test('la numerazione decide: 1.2 sta sotto 1', () => {
  const blocks = ['## 1 Il gruppo', '## 1.1 Le regole', '## 1.2 Il conduttore', '## 2 La famiglia'];
  const levels = run(blocks, { 'b-1': 2, 'b-2': 2, 'b-3': 3, 'b-4': 2 });
  assert.equal(levels.get('b-1'), 2);
  assert.equal(levels.get('b-2'), 3);
  assert.equal(levels.get('b-3'), 3);
  assert.equal(levels.get('b-4'), 2);
});

test('niente salti di livello', () => {
  const levels = run(['# Titolo', '### Sezione'], { 'b-1': 1, 'b-2': 3 });
  assert.equal(levels.get('b-2'), 2);
});

test('Parte sta sopra Capitolo', () => {
  const levels = run(['## Parte prima', '## Capitolo 1', '## Capitolo 2'], { 'b-1': 2, 'b-2': 2 });
  assert.ok(levels.get('b-2') > levels.get('b-1'));
  assert.equal(levels.get('b-2'), levels.get('b-3'));
});

test('forme riconosciute', () => {
  assert.equal(headingShape('2.3.1 Il setting').signature, 'dec:3');
  assert.equal(headingShape('IV – La seduta').kind, 'roman');
  assert.equal(headingShape('LA VOCE DEL GRUPPO', 3).signature, 'none:3:C');
});

test('nel documento finale', () => {
  const out = markdownToStrictTypst('## 1 Uno\n\n### 1.1 Due\n\n## 2 Tre', {});
  assert.match(out, /^== 1 Uno$/m);
  assert.match(out, /^=== 1\.1 Due$/m);
});
