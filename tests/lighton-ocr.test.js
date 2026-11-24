import test from 'node:test';
import assert from 'node:assert/strict';
import { promptFor, isLightOn, ollamaRecognize } from '../src/lib/ollamaOcr.js';
import { ensureOllamaModel } from '../src/lib/ollamaModels.js';
import { regionToBlock } from '../src/lib/layoutOcr.js';

test('LightOnOCR-3: prompt vuoto per ogni compito, gli altri modelli no', () => {
  assert.ok(isLightOn('richardyoung/lightonocr-3-4b:Q6_K'));
  for (const task of ['text', 'table', 'formula', 'page']) {
    assert.equal(promptFor('richardyoung/lightonocr-3-1b', task), '');
  }
  assert.equal(promptFor('hf.co/PaddlePaddle/PaddleOCR-VL-1.6-GGUF', 'text'), 'OCR:');
  assert.notEqual(promptFor('gemma4:e4b', 'text'), '');
});

test('LightOnOCR-3: la richiesta contiene solo l’immagine', async () => {
  const realFetch = globalThis.fetch;
  let body;
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(init.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: '# Titolo' } }] }) };
  };
  try {
    await ollamaRecognize({ model: 'richardyoung/lightonocr-3-1b', imageDataUrl: 'data:image/png;base64,AA' });
    assert.deepEqual(body.messages[0].content.map((p) => p.type), ['image_url']);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('regionToBlock toglie i # e il grassetto del Markdown di LightOnOCR', () => {
  const region = { bbox: { xmin: 0, ymin: 0, xmax: 1, ymax: 0.1 }, order: 1 };
  const b = regionToBlock(region, { action: 'read', type: 'Section-header', task: 'text' }, '## **Mi presento**');
  assert.equal(b.type, 'Section-header');
  assert.equal(b.text, 'Mi presento');
  const t = regionToBlock(region, { action: 'read', type: 'Text', task: 'text' }, '# Un paragrafo\ncontinua qui');
  assert.equal(t.text, 'Un paragrafo continua qui');
});

test('ensureOllamaModel: non scarica se il modello c’è (anche come :latest)', async () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return { ok: true, json: async () => ({ models: [{ name: 'richardyoung/lightonocr-3-1b:latest' }] }) };
  };
  try {
    await ensureOllamaModel({ endpoint: 'http://x:1/v1/chat/completions', model: 'richardyoung/lightonocr-3-1b' });
    assert.deepEqual(calls, ['http://x:1/api/tags']);
    await ensureOllamaModel({ endpoint: 'http://x:1/v1/chat/completions', model: 'richardyoung/lightonocr-3-1b' });
    assert.equal(calls.length, 1); // in cache
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('ensureOllamaModel: se manca chiama /api/pull', async () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith('/api/tags')) return { ok: true, json: async () => ({ models: [] }) };
    const enc = new TextEncoder().encode('{"status":"success"}\n');
    let sent = false;
    return {
      ok: true,
      body: { getReader: () => ({ read: async () => (sent ? { done: true } : ((sent = true), { done: false, value: enc })) }) },
    };
  };
  try {
    await ensureOllamaModel({ endpoint: 'http://y:2', model: 'm:1' });
    assert.deepEqual(calls, ['http://y:2/api/tags', 'http://y:2/api/pull']);
  } finally {
    globalThis.fetch = realFetch;
  }
});
