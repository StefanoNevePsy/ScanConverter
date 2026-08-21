/*
  Migrazione delle impostazioni salvate.

  Chi aggiorna l'app aveva già scelto motori e modelli per ogni fase, con le
  vecchie chiavi sparse. Se la migrazione sbaglia, si ritrova l'OCR su un
  motore diverso da quello che usava ieri — senza che nulla glielo dica.
*/

import test from 'node:test';
import assert from 'node:assert/strict';

import { PHASE_DEFAULTS } from '../src/lib/phases.js';

/** localStorage minimo: `loadSettings` legge solo get/set/remove. */
function installStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
  return map;
}

/** Il modulo tiene stato zero, ma va riletto dopo aver cambiato localStorage. */
async function freshStorageModule() {
  return import(`../src/lib/storage.js?${Math.random()}`);
}

test('un’installazione vecchia ritrova le proprie scelte, fase per fase', async () => {
  installStorage({
    'sc.ocrEngine': 'gemini',
    'sc.geminiOcrModel': 'gemini-2.5-flash',
    'sc.typstEngine': 'nvidia',
    'sc.nvidiaTypstModel': 'meta/llama-3.3-70b-instruct',
    'sc.fixEngine': 'local',
    'sc.localModel': 'qwen3:14b',
  });
  const { loadSettings } = await freshStorageModule();
  const { phases } = loadSettings();

  assert.equal(phases.ocr.engine, 'gemini');
  assert.equal(phases.ocr.models.gemini, 'gemini-2.5-flash');
  assert.equal(phases.typst.engine, 'nvidia');
  assert.equal(phases.typst.models.nvidia, 'meta/llama-3.3-70b-instruct');
  // Rilettura e riparazione condividevano `fixEngine`: entrambe lo ereditano.
  assert.equal(phases.proof.engine, 'local');
  assert.equal(phases.fix.engine, 'local');
  assert.equal(phases.fix.models.local, 'qwen3:14b');
});

test('la traduzione, che prima non esisteva, parte dai suoi default', async () => {
  installStorage({ 'sc.ocrEngine': 'gemini', 'sc.fixEngine': 'local' });
  const { loadSettings } = await freshStorageModule();
  const { phases } = loadSettings();
  assert.equal(phases.translate.engine, PHASE_DEFAULTS.translate.engine);
  assert.equal(
    phases.translate.models.gemini,
    PHASE_DEFAULTS.translate.models.gemini,
    'un modello economico: la traduzione fa molte chiamate',
  );
});

test('il vecchio modello Gemini unico vale per tutte le fasi Gemini', async () => {
  installStorage({ 'sc.geminiModel': 'gemini-1.5-pro' });
  const { loadSettings } = await freshStorageModule();
  const { phases } = loadSettings();
  assert.equal(phases.ocr.models.gemini, 'gemini-1.5-pro');
  assert.equal(phases.typst.models.gemini, 'gemini-1.5-pro');
});

test('senza nulla di salvato si ottengono i default, non campi vuoti', async () => {
  installStorage();
  const { loadSettings } = await freshStorageModule();
  const { phases } = loadSettings();
  assert.deepEqual(phases, PHASE_DEFAULTS);
});

test('salvataggio e rilettura conservano la configurazione per fase', async () => {
  const map = installStorage();
  const { loadSettings, saveSettings } = await freshStorageModule();
  const settings = loadSettings();
  settings.phases = {
    ...settings.phases,
    translate: { engine: 'local', models: { ...settings.phases.translate.models, local: 'gemma3' } },
  };
  saveSettings(settings);

  // Una chiave sola, non una per combinazione fase/motore.
  const keys = [...map.keys()].filter((k) => k.startsWith('sc.phase'));
  assert.deepEqual(keys, ['sc.phases']);

  const reread = loadSettings().phases;
  assert.equal(reread.translate.engine, 'local');
  assert.equal(reread.translate.models.local, 'gemma3');
  assert.equal(reread.ocr.engine, PHASE_DEFAULTS.ocr.engine);
});

test('le impostazioni di traduzione hanno default sensati e limiti', async () => {
  installStorage({ 'sc.translateOverlap': '99' });
  const { loadSettings, DEFAULTS } = await freshStorageModule();
  const settings = loadSettings();
  assert.equal(settings.targetLang, DEFAULTS.targetLang);
  assert.equal(settings.sourceLang, 'auto');
  assert.ok(settings.translateOverlap <= 6, `sovrapposizione non limitata: ${settings.translateOverlap}`);
});

test('una configurazione salvata corrotta non rompe l’avvio', async () => {
  installStorage({ 'sc.phases': '{non json' });
  const { loadSettings } = await freshStorageModule();
  assert.deepEqual(loadSettings().phases, PHASE_DEFAULTS);
});
