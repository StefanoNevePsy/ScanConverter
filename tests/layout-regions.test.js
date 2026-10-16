import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLayoutOutput, planRegion, joinRegionLines, LAYOUT_LABELS } from '../src/lib/layoutRegions.js';
import { regionToBlock } from '../src/lib/layoutOcr.js';

const L = (name) => LAYOUT_LABELS.indexOf(name);

test('uscita del modello: soglia, doppioni, ordine di lettura, coordinate in frazioni', () => {
  // Dalla pagina 21 del Manuale SST: «CAPITOLO» proposto due volte.
  const rows = [
    [L('doc_title'), 0.92, 463, 638, 1040, 864, 148],
    [L('text'), 0.48, 645, 284, 862, 338, 123],
    [L('header'), 0.29, 645, 284, 862, 338, 123],
    [L('text'), 0.2, 0, 0, 10, 10, 1],
  ].flat();
  const regions = parseLayoutOutput(rows, 4, 1600, 2600);
  assert.deepEqual(regions.map((r) => r.label), ['text', 'doc_title']);
  assert.ok(Math.abs(regions[1].bbox.xmin - 463 / 1600) < 1e-6);
});

test('piano per zona: testatine saltate, immagini piccole controllate', () => {
  assert.equal(planRegion({ label: 'header', bbox: {} }).action, 'skip');
  assert.equal(planRegion({ label: 'paragraph_title', bbox: {} }).type, 'Section-header');
  assert.equal(planRegion({ label: 'image', bbox: { xmin: 0.4, ymin: 0.1, xmax: 0.5, ymax: 0.2 } }).action, 'probe');
  assert.equal(planRegion({ label: 'image', bbox: { xmin: 0.1, ymin: 0.1, xmax: 0.9, ymax: 0.6 } }).action, 'keep');
  assert.equal(planRegion({ label: 'table', bbox: {} }).task, 'table');
});

test('righe della zona unite, sillabazione sciolta, elenchi separati', () => {
  assert.equal(joinRegionLines('Si affrontano le aspet-\ntative dei partecipanti\nnel gruppo.', 'Text'), 'Si affrontano le aspettative dei partecipanti nel gruppo.');
  assert.equal(joinRegionLines('• uno\n• due', 'Text'), '• uno\n• due');
});

test('apertura di capitolo: il «3» nel cerchio diventa testo, gli autori non sono un titolo', () => {
  const box = { xmin: 0.4, ymin: 0.1, xmax: 0.5, ymax: 0.2 };
  assert.equal(regionToBlock({ bbox: box, order: 1 }, { type: 'Picture', action: 'probe' }, '3').type, 'Text');
  assert.equal(regionToBlock({ bbox: box, order: 1 }, { type: 'Picture', action: 'probe' }, 'nastro adesivo').type, 'Picture');
  const authors = regionToBlock({ bbox: box, order: 2 }, { type: 'Title', action: 'read', task: 'text' }, 'R. Castaldo, S. Bari, G. Tocchi, R. Keller');
  assert.equal(authors.type, 'Text');
  const title = regionToBlock({ bbox: box, order: 3 }, { type: 'Title', action: 'read', task: 'text' }, 'Dalla teoria\nalla pratica');
  assert.deepEqual([title.type, title.text], ['Title', 'Dalla teoria alla pratica']);
});
