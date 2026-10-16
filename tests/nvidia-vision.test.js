import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPageBlocks } from '../src/lib/nvidia.js';

test('modello di visione NVIDIA (es. Nemotron 3.5 Super VL): pagina in Markdown, niente tools', async () => {
  let body = null;
  globalThis.fetch = async (_u, init) => {
    body = JSON.parse(init.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: '```markdown\n## Regole\n\nTesto.\n```' } }] }) };
  };
  const blocks = await extractPageBlocks({
    apiKey: 'k',
    endpoint: 'https://esempio/v1/chat/completions',
    model: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
    imageDataUrl: 'data:image/png;base64,AAAA',
  });
  assert.equal(body.tools, undefined);
  assert.equal(body.messages.at(-1).content[0].type, 'image_url');
  assert.deepEqual(blocks, [{ type: 'Text', bbox: null, text: '## Regole\n\nTesto.' }]);
});
