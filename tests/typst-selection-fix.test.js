import test from 'node:test';
import assert from 'node:assert/strict';
import { sameWords } from '../src/lib/typstSelectionFix.js';

test('cambiare solo i pallini d’elenco conserva le parole', () => {
  assert.equal(sameWords('• prima voce\n• seconda voce', '- prima voce\n- seconda voce'), true);
  assert.equal(sameWords('o prima\no seconda', '- prima\n- seconda'), true);
});

test('una parola cambiata fa scartare la proposta', () => {
  assert.equal(sameWords('- prima voce', '- prima frase'), false);
  assert.equal(sameWords('- prima voce', '- prima'), false);
});

test('la marcatura Typst non conta come parola', () => {
  assert.equal(sameWords('Testo importante', '*Testo* _importante_'), true);
});

import { applyRule } from '../src/lib/typstSelectionFix.js';

test('una regola si applica a tutto il documento', () => {
  const doc = 'Testo.\n\n• uno\n• due\n\nAltro.\n\n• tre';
  const res = applyRule(doc, { find: '^•\\s*', replace: '- ' });
  assert.equal(res.count, 3);
  assert.equal(res.text, 'Testo.\n\n- uno\n- due\n\nAltro.\n\n- tre');
});

test('i gruppi della regola vengono rispettati', () => {
  const res = applyRule('  o voce', { find: '^(\\s*)o (\\S)', replace: '$1- $2' });
  assert.equal(res.text, '  - voce');
});
