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
