import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLocalBlocks, localChat, localOcrBlocks } from '../src/lib/local.js';
import { engineChat, modelFor, TEXT_ENGINES } from '../src/lib/engines.js';

/* --------------------------------------------- blocchi dal sidecar OCR */

test('normalizza i blocchi del sidecar e scarta quelli vuoti', () => {
  const blocks = normalizeLocalBlocks([
    { type: 'Title', bbox: { xmin: 0.1, ymin: 0.2, xmax: 0.9, ymax: 0.3 }, text: '  Capitolo  ' },
    { type: 'Text', bbox: null, text: 'Senza riquadro' },
    { type: 'Text', bbox: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 }, text: '   ' },
  ]);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].text, 'Capitolo');
  assert.equal(blocks[0].type, 'Title');
  assert.equal(blocks[1].bbox, null);
});

test('riporta dentro 0–1 le coordinate fuori scala e usa Text come ripiego', () => {
  const [block] = normalizeLocalBlocks([
    { bbox: { xmin: -0.5, ymin: 0.2, xmax: 1.4, ymax: 0.6 }, text: 'x' },
  ]);
  assert.equal(block.type, 'Text');
  assert.deepEqual(block.bbox, { xmin: 0, ymin: 0.2, xmax: 1, ymax: 0.6 });
});

test('un bbox incompleto non fa saltare il blocco: resta senza riquadro', () => {
  const [block] = normalizeLocalBlocks([{ bbox: { xmin: 0.1, ymin: 0.2 }, text: 'x' }]);
  assert.equal(block.bbox, null);
});

/* ------------------------------------------------------- client locale */

test('localChat parla la forma OpenAI e toglie il ragionamento', async () => {
  let sent = null;
  globalThis.fetch = async (url, opts) => {
    sent = { url: String(url), body: JSON.parse(opts.body), headers: opts.headers };
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '<think>rifletto</think>Risposta pulita.' } }],
      }),
    };
  };
  const text = await localChat({
    endpoint: 'http://localhost:11434/v1/chat/completions',
    model: 'qwen3:8b',
    system: 'sistema',
    user: 'utente',
  });
  assert.equal(text, 'Risposta pulita.');
  assert.equal(sent.body.model, 'qwen3:8b');
  assert.equal(sent.body.messages[0].role, 'system');
  assert.equal(sent.body.stream, false);
  // Nessuna chiave API deve finire in una richiesta locale.
  assert.ok(!('Authorization' in sent.headers));
});

test('server locale spento: il messaggio dice cosa fare', async () => {
  globalThis.fetch = async () => {
    throw new Error('ECONNREFUSED');
  };
  await assert.rejects(
    () => localChat({ endpoint: 'http://localhost:11434/v1/chat/completions', user: 'x' }),
    /non raggiungibile.*Avvia Ollama/s,
  );
});

test('localOcrBlocks invia l’immagine e normalizza la risposta', async () => {
  let sent = null;
  globalThis.fetch = async (url, opts) => {
    sent = JSON.parse(opts.body);
    return {
      ok: true,
      json: async () => ({
        blocks: [{ type: 'Text', bbox: { xmin: 0, ymin: 0, xmax: 1, ymax: 0.1 }, text: 'ciao' }],
      }),
    };
  };
  const blocks = await localOcrBlocks({
    endpoint: 'http://localhost:8000/ocr',
    imageDataUrl: 'data:image/png;base64,AAA',
  });
  assert.equal(sent.image, 'data:image/png;base64,AAA');
  assert.equal(blocks[0].text, 'ciao');
});

/* ------------------------------------------------------------ dispatcher */

test('il dispatcher instrada al server locale senza chiavi', async () => {
  let url = null;
  globalThis.fetch = async (u, opts) => {
    url = String(u);
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
  };
  const out = await engineChat({
    settings: { localEndpoint: 'http://127.0.0.1:11434/v1/chat/completions', localModel: 'mistral' },
    engine: 'local',
    user: 'testo',
  });
  assert.equal(out, 'ok');
  assert.match(url, /127\.0\.0\.1:11434/);
});

test('un motore sconosciuto ricade su NVIDIA invece di rompersi', async () => {
  let url = null;
  globalThis.fetch = async (u) => {
    url = String(u);
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
  };
  await engineChat({
    settings: { nvidiaApiKey: 'k', nvidiaEndpoint: 'https://esempio/v1/chat/completions' },
    engine: 'sconosciuto',
    user: 'testo',
  });
  assert.match(url, /esempio/);
});

test('modelFor sceglie il campo giusto per ciascun motore', () => {
  const settings = {
    localModel: 'qwen3:8b',
    geminiTypstModel: 'gemini-flash-latest',
    nvidiaTypstModel: 'meta/llama-3.3-70b-instruct',
  };
  assert.equal(modelFor(settings, 'local', 'ignorato'), 'qwen3:8b');
  assert.equal(modelFor(settings, 'gemini', 'gemini-pro'), 'gemini-pro');
  assert.equal(modelFor(settings, 'gemini'), 'gemini-flash-latest');
  assert.equal(modelFor(settings, 'nvidia'), 'meta/llama-3.3-70b-instruct');
  assert.deepEqual(TEXT_ENGINES, ['gemini', 'nvidia', 'local']);
});
