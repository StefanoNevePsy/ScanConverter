import test from 'node:test';
import assert from 'node:assert/strict';
import { italianTypography } from '../src/lib/typography.js';

const fix = (s) => italianTypography(s).text;

test('accenti scritti come apostrofi', () => {
  assert.equal(fix("E' difficile. Non so perche' piu' di tanto."), 'È difficile. Non so perché più di tanto.');
  assert.equal(fix("La citta' e' grande, cosi' com'era."), 'La città è grande, così com’era.');
  assert.equal(fix("Poiche' l'uno"), 'Poiché l’uno');
});

test('le eccezioni restano', () => {
  assert.equal(fix("Aspetta un po' qui, di' la verità."), 'Aspetta un po\' qui, di\' la verità.');
});

test('elisioni e spazi', () => {
  assert.equal(fix("l'altro  dice ,  « bene »"), 'l’altro dice, «bene»');
});

test('il testo corretto non cambia', () => {
  const ok = 'È già così: perché l’altro non può.';
  assert.equal(fix(ok), ok);
});
