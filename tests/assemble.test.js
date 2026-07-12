import test from 'node:test';
import assert from 'node:assert/strict';
import { isPageFurniture } from '../src/lib/assemble.js';

test('riconosce i numeri pagina anche dentro l’ampio margine inferiore', () => {
  assert.equal(isPageFurniture({
    type: 'Text',
    text: '19',
    bbox: { xmin: 0.48, xmax: 0.52, ymin: 0.86, ymax: 0.89 },
  }), true);
  assert.equal(isPageFurniture({
    type: 'Page-number',
    text: 'XIX',
    bbox: { xmin: 0.48, xmax: 0.52, ymin: 0.84, ymax: 0.88 },
  }), true);
});

test('non scarta numeri che fanno parte del contenuto', () => {
  assert.equal(isPageFurniture({
    type: 'Text',
    text: '19 pazienti completarono lo studio',
    bbox: { xmin: 0.1, xmax: 0.7, ymin: 0.84, ymax: 0.89 },
  }), false);
  assert.equal(isPageFurniture({
    type: 'Text',
    text: '1985',
    bbox: { xmin: 0.4, xmax: 0.6, ymin: 0.4, ymax: 0.45 },
  }), false);
  assert.equal(isPageFurniture({
    type: 'Text',
    text: 'i',
    bbox: { xmin: 0.4, xmax: 0.6, ymin: 0.86, ymax: 0.9 },
  }), false);
});
