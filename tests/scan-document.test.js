import test from 'node:test';
import assert from 'node:assert/strict';
import { splitTextByPage, buildScanTypst, textAreaOf } from '../src/lib/scanDocument.js';

test('il testo si divide per pagina seguendo i segni di pagina', () => {
  const md = '<!-- pagina 1 -->\n## Regole\n\nTesto uno.\n\n<!-- pagina 2 -->\nTesto «due».';
  assert.deepEqual(splitTextByPage(md, 2), ['Regole Testo uno.', 'Testo «due».']);
});

test('ogni pagina: immagine a piena pagina e testo invisibile nella zona del testo', () => {
  const src = buildScanTypst([
    { path: 'pagine/p0001.jpg', width: 1000, height: 1600, text: 'Un "esempio" \\ di testo', area: { xmin: 0.1, ymin: 0.1, xmax: 0.9, ymax: 0.9 } },
  ]);
  assert.match(src, /#page\(width: 595pt, height: 952pt\)\[/);
  assert.match(src, /image\("pagine\/p0001\.jpg", width: 100%, height: 100%\)/);
  assert.match(src, /fill: rgb\(0, 0, 0, 0\)/);
  assert.match(src, /#"Un \\"esempio\\" \\\\ di testo"/);
});

test('zona del testo: unione dei blocchi, figure e testatine escluse', () => {
  const area = textAreaOf([
    { type: 'Text', text: 'a', bbox: { xmin: 0.1, ymin: 0.2, xmax: 0.5, ymax: 0.3 } },
    { type: 'Text', text: 'b', bbox: { xmin: 0.2, ymin: 0.4, xmax: 0.9, ymax: 0.8 } },
    { type: 'Page-header', text: 'testatina', bbox: { xmin: 0, ymin: 0, xmax: 1, ymax: 0.05 } },
  ]);
  assert.deepEqual(area, { xmin: 0.1, ymin: 0.2, xmax: 0.9, ymax: 0.8 });
});
