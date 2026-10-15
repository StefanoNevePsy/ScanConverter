import test from 'node:test';
import assert from 'node:assert/strict';
import { engineChat } from '../src/lib/engines.js';

test('motore Apple: istruzioni e testo arrivano insieme a «fm respond»', async () => {
  let sent = null;
  globalThis.window = {
    scanConverterDesktop: {
      appleRespond: async (req) => {
        sent = req;
        return { ok: true, text: '```json\n{"ok":true}\n```' };
      },
    },
  };
  const out = await engineChat({
    settings: { phases: { proof: { engine: 'apple', models: {} } } },
    phase: 'proof',
    system: 'Correggi i refusi.',
    user: 'Testo da correggere.',
    json: true,
  });
  assert.equal(out, '{"ok":true}');
  assert.match(sent.prompt, /ISTRUZIONI:\nCorreggi i refusi\./);
  assert.match(sent.prompt, /Testo da correggere\./);
  assert.equal(sent.model, 'system');
  delete globalThis.window;
});

test('motore Apple fuori dall’app desktop: errore chiaro', async () => {
  await assert.rejects(
    engineChat({ settings: { phases: { proof: { engine: 'apple', models: {} } } }, phase: 'proof', user: 'x' }),
    /solo nell’app desktop su un Mac/,
  );
});
