/*
  La configurazione per fase sostituisce cinque convenzioni diverse. Il rischio
  vero non è la nuova struttura ma la MIGRAZIONE: chi aggiorna non deve
  ritrovarsi l'app riconfigurata a caso. Questi test coprono il passaggio dai
  vecchi campi sparsi e le regole che decidono quali chiavi API servono.
*/

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PHASES,
  PHASE_DEFAULTS,
  normalizeEngine,
  phaseConfig,
  requiredKeys,
  usesEngine,
  withPhase,
} from '../src/lib/phases.js';

/* --------------------------------------------------------- risoluzione */

test('senza nulla di salvato ogni fase usa i propri default', () => {
  for (const phase of PHASES) {
    const { engine, model } = phaseConfig({}, phase);
    assert.equal(engine, PHASE_DEFAULTS[phase].engine, phase);
    assert.equal(model, PHASE_DEFAULTS[phase].models[engine], phase);
  }
});

test('il modello segue il motore scelto, non la fase', () => {
  const settings = {
    phases: {
      typst: { engine: 'nvidia', models: { gemini: 'gemini-pro', nvidia: 'meta/llama' } },
    },
  };
  assert.deepEqual(phaseConfig(settings, 'typst'), { engine: 'nvidia', model: 'meta/llama' });
});

test('un motore non ammesso per la fase ricade sul default', () => {
  assert.equal(normalizeEngine('ocr', 'inesistente'), PHASE_DEFAULTS.ocr.engine);
  assert.equal(phaseConfig({ phases: { fix: { engine: 'x' } } }, 'fix').engine, 'nvidia');
});

test('le fasi sono indipendenti: cambiarne una non tocca le altre', () => {
  const before = { phases: PHASE_DEFAULTS };
  const after = withPhase(before, 'translate', { engine: 'local' });
  assert.equal(phaseConfig(after, 'translate').engine, 'local');
  for (const phase of PHASES.filter((p) => p !== 'translate')) {
    assert.deepEqual(phaseConfig(after, phase), phaseConfig(before, phase), phase);
  }
});

test('cambiando motore il modello precedente resta a disposizione', () => {
  let settings = { phases: PHASE_DEFAULTS };
  settings = withPhase(settings, 'proof', { engine: 'nvidia', model: 'z-ai/glm-5.2' });
  settings = withPhase(settings, 'proof', { engine: 'local' });
  settings = withPhase(settings, 'proof', { engine: 'local', model: 'qwen3:14b' });
  assert.equal(phaseConfig(settings, 'proof').model, 'qwen3:14b');

  // Tornando a NVIDIA si ritrova la scelta di prima, non un default generico.
  settings = withPhase(settings, 'proof', { engine: 'nvidia' });
  assert.deepEqual(phaseConfig(settings, 'proof'), { engine: 'nvidia', model: 'z-ai/glm-5.2' });
});

test('usesEngine guarda solo le fasi indicate', () => {
  const settings = withPhase({ phases: PHASE_DEFAULTS }, 'translate', { engine: 'local' });
  assert.equal(usesEngine(settings, 'local'), true);
  assert.equal(usesEngine(settings, 'local', ['ocr', 'typst']), false);
});

/* ------------------------------------------------------- chiavi API */

test('servono solo le chiavi dei motori che partono da soli', () => {
  // OCR NVIDIA + Typst Gemini: entrambe le chiavi.
  const misto = requiredKeys({ phases: PHASE_DEFAULTS });
  assert.deepEqual(misto, { google: true, nvidia: true });

  // Tutto in locale: nessuna chiave, l'app deve poter partire senza.
  let locale = { phases: PHASE_DEFAULTS };
  for (const phase of PHASES) locale = withPhase(locale, phase, { engine: 'local' });
  assert.deepEqual(requiredKeys(locale), { google: false, nvidia: false });
});

test('una fase che parte solo su richiesta non blocca l’avvio', () => {
  let settings = { phases: PHASE_DEFAULTS };
  for (const phase of PHASES) settings = withPhase(settings, phase, { engine: 'local' });
  // Riparazione e traduzione su Gemini: si eseguono solo se l'utente le chiede,
  // quindi non devono pretendere la chiave prima ancora di caricare un file.
  settings = withPhase(settings, 'fix', { engine: 'gemini' });
  settings = withPhase(settings, 'translate', { engine: 'gemini' });
  assert.equal(requiredKeys(settings).google, false);
});

test('la rilettura pretende la chiave solo quando è automatica', () => {
  let settings = { phases: PHASE_DEFAULTS, formatWorkflow: 'strict', fixTypos: true };
  for (const phase of PHASES) settings = withPhase(settings, phase, { engine: 'local' });
  settings = withPhase(settings, 'proof', { engine: 'gemini' });
  assert.equal(requiredKeys(settings).google, true, 'con fixTypos la rilettura è automatica');
  assert.equal(requiredKeys({ ...settings, fixTypos: false }).google, false);
});

test('il confronto fra OCR e il riparsing tabelle chiedono le chiavi che usano', () => {
  let locale = { phases: PHASE_DEFAULTS };
  for (const phase of PHASES) locale = withPhase(locale, phase, { engine: 'local' });

  // Il confronto interroga entrambi i servizi in rete.
  assert.deepEqual(
    requiredKeys({ ...locale, formatWorkflow: 'strict', compareOcr: true }),
    { google: true, nvidia: true },
  );
  // Il riparsing tabelle è vision e passa sempre da Gemini.
  assert.deepEqual(requiredKeys({ ...locale, refineTables: true }), { google: true, nvidia: false });
});
