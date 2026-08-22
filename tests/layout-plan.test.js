import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleLayoutDescriptors } from '../src/lib/layoutPlan.js';

function descriptors(count) {
  return Array.from({ length: count }, (_, i) => ({
    id: `b-${i}`,
    kind: i % 7 === 0 ? 'heading' : 'prose',
    text: `${i}:` + ' testo specialistico'.repeat(40),
  }));
}

test('il piano locale usa un campione compatibile con un contesto da 4096 token', () => {
  const sample = sampleLayoutDescriptors(descriptors(500), true);
  assert.equal(sample.length, 32);
  assert.ok(sample.every((item) => item.text.length <= 140));
  assert.equal(sample[0].id, 'b-0');
  assert.ok(Number(sample.at(-1).id.slice(2)) > 470, 'il campione deve coprire anche la fine del libro');
});

test('il piano cloud conserva il campione editoriale più ampio', () => {
  const sample = sampleLayoutDescriptors(descriptors(500), false);
  assert.equal(sample.length, 120);
  assert.ok(sample.every((item) => item.text.length <= 320));
});
