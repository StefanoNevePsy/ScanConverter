import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildReviewStops,
  stopContext,
  stopIndexAtOrAfter,
  stepStop,
  stopLines,
} from '../src/lib/reviewQueue.js';

const suspect = (word, extra = {}) => ({ word, count: 1, context: '', ...extra });

test('le fermate seguono l’ordine del documento, non la frequenza', () => {
  const text = 'Il zebrone corre.\nPoi arriva il quaffo.\nAncora zebrone.';
  // Il report arriva ordinato per frequenza: «zebrone» (2) prima di «quaffo».
  const stops = buildReviewStops(text, [suspect('zebrone'), suspect('quaffo')]);
  assert.deepEqual(stops.map((s) => s.word), ['zebrone', 'quaffo', 'zebrone']);
  assert.deepEqual(stops.map((s) => s.start), [3, 32, 47]);
  assert.deepEqual(stops.map((s) => s.line), [1, 2, 3]);
});

test('ogni fermata sa quale occorrenza è, per la sincronia con il PDF', () => {
  const text = 'zebrone qui, zebrone là';
  const stops = buildReviewStops(text, [suspect('zebrone')]);
  assert.deepEqual(stops.map((s) => s.occurrence), [0, 1]);
});

test('le parole intere non si fermano dentro un’altra parola', () => {
  const text = 'la casa e la casalinga';
  const stops = buildReviewStops(text, [suspect('casa')]);
  assert.equal(stops.length, 1);
  assert.equal(stops[0].start, 3);
});

test('uno span OCR con trattino viene cercato letteralmente', () => {
  const text = 'un compor- tamento strano';
  const stops = buildReviewStops(text, [suspect('compor- tamento', { suggestedFix: 'comportamento' })]);
  assert.equal(stops.length, 1);
  assert.equal(stops[0].suggestedFix, 'comportamento');
  assert.equal(text.slice(stops[0].start, stops[0].end), 'compor- tamento');
});

test('una parola contenuta in uno span già segnalato non crea una seconda fermata', () => {
  // Senza deduplica l'utente rivedrebbe due volte lo stesso punto, e la
  // seconda volta il testo corretto non ci sarebbe più.
  const text = 'un compor- tamento strano';
  const stops = buildReviewStops(text, [suspect('compor- tamento'), suspect('tamento')]);
  assert.equal(stops.length, 1);
  assert.equal(stops[0].word, 'compor- tamento');
});

test('le parole archiviate dall’utente non producono fermate', () => {
  const text = 'Bateson e il zebrone';
  const stops = buildReviewStops(text, [suspect('Bateson'), suspect('zebrone')], {
    skip: new Set(['Bateson']),
  });
  assert.deepEqual(stops.map((s) => s.word), ['zebrone']);
});

test('una parola sparita dal testo non produce fermate', () => {
  const stops = buildReviewStops('testo già corretto', [suspect('zebrone')]);
  assert.deepEqual(stops, []);
});

test('il contesto viene dal Typst attuale, con i tagli segnalati', () => {
  const text = `${'a'.repeat(80)} zebrone ${'b'.repeat(80)}`;
  const at = text.indexOf('zebrone');
  const context = stopContext(text, at, at + 7, 10);
  assert.equal(context.word, 'zebrone');
  assert.equal(context.before, '…aaaaaaaaa ');
  assert.equal(context.after, ' bbbbbbbbb…');
});

test('il contesto non segnala tagli quando il documento è corto', () => {
  const text = 'solo zebrone qui';
  const at = text.indexOf('zebrone');
  const context = stopContext(text, at, at + 7);
  assert.equal(context.before, 'solo ');
  assert.equal(context.after, ' qui');
});

test('il contesto appiattisce gli a capo su una riga sola', () => {
  const text = 'riga uno\nzebrone\nriga tre';
  const at = text.indexOf('zebrone');
  const context = stopContext(text, at, at + 7);
  assert.equal(context.before, 'riga uno ');
  assert.equal(context.after, ' riga tre');
});

test('stopIndexAtOrAfter ritrova il posto dopo una correzione', () => {
  const stops = [{ start: 10 }, { start: 40 }, { start: 90 }];
  assert.equal(stopIndexAtOrAfter(stops, 0), 0);
  assert.equal(stopIndexAtOrAfter(stops, 40), 1);
  // La fermata a 40 è stata corretta e non c'è più: si continua da quella dopo.
  assert.equal(stopIndexAtOrAfter([{ start: 10 }, { start: 90 }], 40), 1);
  // Oltre l'ultima si resta sull'ultima: la revisione finisce, non riparte.
  assert.equal(stopIndexAtOrAfter(stops, 500), 2);
  assert.equal(stopIndexAtOrAfter([], 10), -1);
});

test('stepStop gira in tondo in entrambi i versi', () => {
  const stops = [{ start: 1 }, { start: 2 }, { start: 3 }];
  assert.equal(stepStop(stops, 0, 1), 1);
  assert.equal(stepStop(stops, 2, 1), 0);
  assert.equal(stepStop(stops, 0, -1), 2);
  assert.equal(stepStop([], 0, 1), -1);
});

test('stopLines raggruppa per riga e conta i sospetti', () => {
  const text = 'zebrone e quaffo insieme\nriga pulita\nun altro zebrone';
  const stops = buildReviewStops(text, [suspect('zebrone'), suspect('quaffo')]);
  const lines = stopLines(stops);
  assert.deepEqual(lines.map((l) => [l.line, l.count]), [[1, 2], [3, 1]]);
  // Il puntino porta alla PRIMA fermata della riga.
  assert.equal(lines[0].start, 0);
});

test('il limite di fermate protegge i documenti enormi', () => {
  const text = 'zebrone '.repeat(500);
  const stops = buildReviewStops(text, [suspect('zebrone')], { limit: 25 });
  assert.equal(stops.length, 25);
});
