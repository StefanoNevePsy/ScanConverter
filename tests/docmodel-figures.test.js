/*
  Apparato della pagina: note a margine, figure, didascalie, ornamenti.

  Il primo caso non è ipotetico. Eseguito sul codice precedente, una pagina
  con una nota stretta a sinistra e il corpo a destra usciva così:

      1  NOTA A MARGINE
      2  Primo paragrafo del corpo.
      3  Secondo paragrafo del corpo.
      4  Terzo paragrafo del corpo.

  cioè la nota davanti a TUTTA la pagina, perché l'XY-cut vedeva un varco
  verticale e leggeva la nota come una colonna.
*/

import test from 'node:test';
import assert from 'node:assert/strict';

import { orderBlocks } from '../src/lib/assemble.js';
import {
  horizontalOverlap,
  isMarginalia,
  isOrnament,
  mainTextSpan,
  pairCaptions,
  splitMarginalia,
  verticalGap,
} from '../src/lib/docmodel.js';

const bb = (xmin, ymin, xmax, ymax) => ({ xmin, ymin, xmax, ymax });
const at = (text, box, type = 'Text') => ({ type, text, bbox: box });

/* ------------------------------------------------------- note a margine */

function pageWithMarginNote() {
  return [
    at('Primo paragrafo del corpo.', bb(0.30, 0.10, 0.92, 0.25)),
    at('NOTA A MARGINE', bb(0.04, 0.30, 0.22, 0.38)),
    at('Secondo paragrafo del corpo.', bb(0.30, 0.30, 0.92, 0.45)),
    at('Terzo paragrafo del corpo.', bb(0.30, 0.50, 0.92, 0.65)),
  ];
}

test('la nota a margine non viene più letta prima di tutta la pagina', () => {
  const order = orderBlocks(pageWithMarginNote()).map((b) => b.text);
  assert.notEqual(order[0], 'NOTA A MARGINE', 'era il difetto: la nota apriva la pagina');
  assert.equal(order[0], 'Primo paragrafo del corpo.');
});

test('la nota rientra accanto al paragrafo che le sta a fianco', () => {
  const order = orderBlocks(pageWithMarginNote()).map((b) => b.text);
  const nota = order.indexOf('NOTA A MARGINE');
  const secondo = order.indexOf('Secondo paragrafo del corpo.');
  const terzo = order.indexOf('Terzo paragrafo del corpo.');
  assert.ok(nota > 0, 'non deve stare in testa');
  assert.ok(nota < terzo, `la nota è alla stessa altezza del secondo paragrafo (${order})`);
  assert.ok(Math.abs(nota - secondo) === 1, `deve stare accanto al suo paragrafo: ${order}`);
});

test('nessun blocco viene perso separando i margini', () => {
  const page = pageWithMarginNote();
  assert.equal(orderBlocks(page).length, page.length);
});

test('un impaginato a due colonne resta un impaginato a due colonne', () => {
  // Due colonne si somigliano in larghezza: non sono margini, e vanno lasciate
  // all'XY-cut, che le sa leggere.
  const page = [
    at('Colonna sinistra, primo blocco.', bb(0.06, 0.10, 0.46, 0.40)),
    at('Colonna sinistra, secondo blocco.', bb(0.06, 0.45, 0.46, 0.75)),
    at('Colonna destra, primo blocco.', bb(0.54, 0.10, 0.94, 0.40)),
    at('Colonna destra, secondo blocco.', bb(0.54, 0.45, 0.94, 0.75)),
  ];
  const { margins } = splitMarginalia(page);
  assert.deepEqual(margins, [], 'nessuna colonna deve essere scambiata per margine');
  const order = orderBlocks(page).map((b) => b.text);
  assert.deepEqual(order, [
    'Colonna sinistra, primo blocco.',
    'Colonna sinistra, secondo blocco.',
    'Colonna destra, primo blocco.',
    'Colonna destra, secondo blocco.',
  ]);
});

test('un titolo corto centrato non è una nota a margine', () => {
  const page = [
    at('CONCLUSIONI', bb(0.38, 0.10, 0.62, 0.14)),
    at('Il corpo del testo del capitolo.', bb(0.12, 0.18, 0.88, 0.50)),
  ];
  assert.deepEqual(splitMarginalia(page).margins, [], 'sovrappone la gabbia: è nel flusso');
});

test('la gabbia del testo è quella del blocco più largo', () => {
  const span = mainTextSpan(pageWithMarginNote());
  assert.ok(span.xmin >= 0.29 && span.xmax <= 0.93, JSON.stringify(span));
  assert.equal(isMarginalia(at('x', bb(0.04, 0.3, 0.22, 0.38)), span), true);
  assert.equal(isMarginalia(at('x', bb(0.30, 0.3, 0.92, 0.38)), span), false);
});

/* ---------------------------------------------------- figure e didascalie */

test('la didascalia sotto una figura alta non si perde più', () => {
  // Col confronto fra CENTRI, una figura alta metà pagina metteva il proprio
  // centro a 0.25 dalla didascalia: oltre la soglia, quindi nessun abbinamento.
  const picture = at('', bb(0.15, 0.10, 0.85, 0.60), 'Picture');
  const caption = at('Figura 1. Lo schema del debito', bb(0.15, 0.62, 0.85, 0.66), 'Caption');
  const pairs = pairCaptions([picture], [caption]);
  assert.equal(pairs.get(picture), caption);
});

test('su due colonne la didascalia non attraversa la pagina', () => {
  const left = at('', bb(0.06, 0.20, 0.46, 0.45), 'Picture');
  const right = at('', bb(0.54, 0.20, 0.94, 0.45), 'Picture');
  const capLeft = at('Figura 1', bb(0.06, 0.47, 0.46, 0.51), 'Caption');
  const capRight = at('Figura 2', bb(0.54, 0.47, 0.94, 0.51), 'Caption');
  const pairs = pairCaptions([left, right], [capLeft, capRight]);
  assert.equal(pairs.get(left), capLeft);
  assert.equal(pairs.get(right), capRight);
});

test('due figure vicine non si contendono la stessa didascalia', () => {
  // L'assegnazione golosa dava alla prima figura incontrata la didascalia più
  // vicina, anche quando apparteneva chiaramente alla seconda.
  const first = at('', bb(0.15, 0.10, 0.85, 0.30), 'Picture');
  const second = at('', bb(0.15, 0.40, 0.85, 0.60), 'Picture');
  const capFirst = at('Figura 1', bb(0.15, 0.32, 0.85, 0.36), 'Caption');
  const capSecond = at('Figura 2', bb(0.15, 0.62, 0.85, 0.66), 'Caption');
  const pairs = pairCaptions([first, second], [capFirst, capSecond]);
  assert.equal(pairs.get(first), capFirst);
  assert.equal(pairs.get(second), capSecond);
});

test('una didascalia lontana non viene attribuita a forza', () => {
  const picture = at('', bb(0.15, 0.10, 0.85, 0.30), 'Picture');
  const far = at('Un paragrafo in fondo alla pagina', bb(0.15, 0.80, 0.85, 0.90), 'Caption');
  assert.equal(pairCaptions([picture], [far]).size, 0);
});

test('una didascalia sopra la figura vale, ma perde contro una sotto', () => {
  const picture = at('', bb(0.15, 0.30, 0.85, 0.50), 'Picture');
  const above = at('Figura A', bb(0.15, 0.26, 0.85, 0.29), 'Caption');
  assert.equal(pairCaptions([picture], [above]).get(picture), above);

  const below = at('Figura B', bb(0.15, 0.51, 0.85, 0.54), 'Caption');
  assert.equal(
    pairCaptions([picture], [above, below]).get(picture),
    below,
    'a parità di distanza la posizione convenzionale è sotto',
  );
});

test('sovrapposizione e distanza si misurano fra i bordi, non fra i centri', () => {
  assert.equal(horizontalOverlap(bb(0, 0, 1, 1), bb(0.5, 0, 1.5, 1)), 0.5);
  assert.equal(horizontalOverlap(bb(0, 0, 0.4, 1), bb(0.6, 0, 1, 1)), 0);
  assert.equal(verticalGap(bb(0, 0, 1, 0.3), bb(0, 0.4, 1, 0.6)).toFixed(4), '0.1000');
  assert.equal(verticalGap(bb(0, 0, 1, 0.5), bb(0, 0.3, 1, 0.8)), 0, 'si sovrappongono');
});

/* --------------------------------------------------------- ornamenti */

test('il numero di capitolo stampato grande è un ornamento, non una figura', () => {
  // Nel libro reale tutte e sei le «figure» estratte erano di questo tipo:
  // piccole, in cima alla pagina, senza didascalia, subito prima del titolo.
  const ornament = at('', bb(0.10, 0.08, 0.22, 0.16), 'Picture');
  const page = [ornament, at('2. LA TEORIA DIALETTICA', bb(0.12, 0.22, 0.88, 0.28))];
  assert.equal(isOrnament(ornament, null, page), true);
});

test('una figura con didascalia non è mai un ornamento', () => {
  const picture = at('', bb(0.10, 0.08, 0.22, 0.16), 'Picture');
  const caption = at('Figura 1', bb(0.10, 0.17, 0.22, 0.20), 'Caption');
  assert.equal(isOrnament(picture, caption, [picture, caption]), false);
});

test('una figura grande in cima alla pagina resta una figura', () => {
  const picture = at('', bb(0.10, 0.08, 0.90, 0.55), 'Picture');
  assert.equal(isOrnament(picture, null, [picture]), false, 'troppo grande per un ornamento');
});

test('una figura piccola in mezzo al testo resta una figura', () => {
  const picture = at('', bb(0.40, 0.45, 0.60, 0.55), 'Picture');
  const page = [at('Del testo sopra.', bb(0.12, 0.10, 0.88, 0.40)), picture];
  assert.equal(isOrnament(picture, null, page), false, 'ha testo sopra: è nel flusso');
});
