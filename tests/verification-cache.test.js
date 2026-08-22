import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPdfVerificationKey,
  figureCollectionSignature,
  reusablePdfVerification,
} from '../src/lib/verificationCache.js';

test('l’impronta PDF cambia con sorgente, fonte canonica e figure', async () => {
  const figures = [{ path: '/figures/a.png', bytes: new Uint8Array([1, 2, 3]) }];
  const base = await createPdfVerificationKey({
    source: '= Libro',
    canonicalText: 'Libro',
    figures,
  });
  assert.equal(base, await createPdfVerificationKey({
    source: '= Libro',
    canonicalText: 'Libro',
    figures,
  }));
  assert.notEqual(base, await createPdfVerificationKey({
    source: '= Libro modificato',
    canonicalText: 'Libro',
    figures,
  }));
  assert.notEqual(base, await createPdfVerificationKey({
    source: '= Libro',
    canonicalText: 'Libro',
    figures: [{ path: '/figures/a.png', bytes: new Uint8Array([1, 2, 4]) }],
  }));
  assert.notEqual(base, await createPdfVerificationKey({
    source: '= Libro',
    canonicalText: 'Libro',
    figures,
    issueResolutions: { 'pagina-1': 'artifact' },
  }));
});

test('la firma delle figure è stabile anche dopo IndexedDB', () => {
  const first = [{ path: '/figures/a.png', bytes: new Uint8Array([1, 2, 3]) }];
  const restored = [{ path: '/figures/a.png', bytes: new Uint8Array([1, 2, 3]) }];
  assert.equal(figureCollectionSignature(first), figureCollectionSignature(restored));
});

test('riusa soltanto un rapporto con la stessa impronta', () => {
  const snapshot = { key: 'abc', pdf: { contentOk: true } };
  assert.equal(reusablePdfVerification(snapshot, 'abc'), true);
  assert.equal(reusablePdfVerification(snapshot, 'def'), false);
  assert.equal(reusablePdfVerification({ key: 'abc' }, 'abc'), false);
});
