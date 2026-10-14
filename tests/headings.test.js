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

import { headingSizeRatios, sizeClasses, mergeHeadingSizes } from '../src/lib/headingSize.js';

// Blocco sintetico: n caratteri, altezza di riga lh, larghezza w (frazioni di pagina).
function block(type, text, x, y, w, lh) {
  const n = text.replace(/\s+/g, '').length;
  const lines = Math.max(1, Math.round((n * lh * 0.5) / w));
  const width = lines === 1 ? n * lh * 0.5 : w;
  return { type, text, bbox: { xmin: x, ymin: y, xmax: x + width, ymax: y + lines * lh } };
}
const para = 'Questo è un paragrafo di testo normale abbastanza lungo per misurare bene. '.repeat(3);

test('la prospettiva non inganna: conta il rapporto col testo vicino', () => {
  // Foto storta: in alto i caratteri sono più piccoli (0.010), in basso più grandi (0.016).
  const page = [
    block('Section-header', 'Il gruppo', 0.1, 0.05, 0.8, 0.010 * 1.5),
    block('Text', para, 0.1, 0.08, 0.8, 0.010),
    block('Text', para, 0.1, 0.7, 0.8, 0.016),
    block('Section-header', 'La famiglia', 0.1, 0.62, 0.8, 0.016 * 1.5),
  ];
  const sizes = headingSizeRatios(page);
  const [a, b] = sizes.map((s) => s.ratio);
  assert.ok(Math.abs(a - 1.5) < 0.15 && Math.abs(b - 1.5) < 0.15, JSON.stringify(sizes));
  // In assoluto i due titoli differiscono del 60%, ma sono la stessa taglia.
  const classes = sizeClasses([a, b]);
  assert.equal(classes.get(a), classes.get(b));
});

test('taglie diverse restano separate', () => {
  const classes = sizeClasses([2.0, 1.9, 1.45, 1.5, 1.15]);
  assert.equal(classes.get(2.0), classes.get(1.9));
  assert.notEqual(classes.get(1.9), classes.get(1.5));
  assert.notEqual(classes.get(1.45), classes.get(1.15));
});

test('titoli senza numero: la taglia separa capitoli e sezioni', () => {
  const blocks = ['## Il conduttore', 'testo', '## Le regole', 'testo', '## La famiglia'];
  const sizes = mergeHeadingSizes([[
    { key: 'ilconduttore', ratio: 2.0 },
    { key: 'leregole', ratio: 1.3 },
    { key: 'lafamiglia', ratio: 1.95 },
  ]]);
  // Il modello ha visto solo i primi due.
  const levels = resolveHeadingLevels(blocks, new Map([['b-1', 2], ['b-3', 3]]), sizes);
  assert.equal(levels.get('b-5'), levels.get('b-1'));
  assert.ok(levels.get('b-3') > levels.get('b-1'));
});
