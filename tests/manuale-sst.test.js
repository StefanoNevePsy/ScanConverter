/*
  Banco di prova reale: pagine 21–25 del «Manuale SST» (vedi
  fixtures/manuale-sst.js), dalla lettura OCR al Typst finale con le sole
  regole fisse (nessun modello). Ogni difetto trovato su questo libro è qui.
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { PAGES } from './fixtures/manuale-sst.js';
import { assemblePage, makeFigureCounter } from '../src/lib/assemble.js';
import { normalizeOcrBullets } from '../src/lib/bullets.js';
import { cleanupBook } from '../src/lib/bookCleanup.js';
import { italianTypography } from '../src/lib/typography.js';
import { buildStrictDocument, repairBoundaryOverlaps } from '../src/lib/strict.js';
import { mergeHeadingSizes } from '../src/lib/headingSize.js';

async function convert() {
  const parts = [];
  const sizes = [];
  for (let i = 0; i < PAGES.length; i++) {
    const page = await assemblePage(PAGES[i], null, makeFigureCounter(0));
    parts.push(`<!-- pagina ${i + 1} -->\n${page.markdown}`);
    sizes.push(page.headingSizes);
  }
  // Stesso ordine della pipeline (usePipeline → startFormat).
  const joined = repairBoundaryOverlaps(
    cleanupBook(normalizeOcrBullets(parts.join('\n\n'))).text,
    10,
    (w) => w.length > 3,
  ).text;
  const md = italianTypography(normalizeOcrBullets(joined)).text;
  return buildStrictDocument(md, { headings: [], blocks: [], document: {}, headingSizes: mergeHeadingSizes(sizes) }).body;
}

test('Manuale SST: struttura dei titoli come nel libro', async () => {
  const body = await convert();
  const headings = body.split('\n').filter((l) => /^=+ /.test(l));
  assert.deepEqual(headings, [
    '= Capitolo 3 – Dalla teoria alla pratica',
    '== INCONTRO 1: INTRODUZIONE E ASPETTATIVE',
    '=== Mi presento',
    '=== Regole',
    '=== La voce del gruppo: aspettative iniziando il percorso',
    '=== Spunti per il conduttore',
    '== ABILITÀ 1: IL SALUTO',
    '=== Definire l’abilità',
    '=== Motivare all’apprendimento',
    '=== La voce del gruppo',
    '=== Spunti per il conduttore',
  ]);
});

test('Manuale SST: testatina, pallini, paragrafi fra pagine, tipografia', async () => {
  const body = await convert();
  assert.doesNotMatch(body, /DALLA TEORIA ALLA PRATICA/, 'testatina corrente rimasta');
  assert.doesNotMatch(body, /bullet/, 'pallini LaTeX rimasti');
  assert.match(body, /incontri necessari per ciascuna abilità/, 'paragrafo fra pagine non ricucito');
  assert.match(body, /abilità ponendo l’accento/);
  assert.match(body, /È importante che i membri/);
  assert.match(body, /pratica, fornendo/);
  // elenchi compatti
  assert.match(body, /^1\. test iniziali \(T0\);\n2\. introduzione/m);
  assert.match(body, /^- "Mi costringo a farlo sempre, mi sforzo\."\n- "A volte balbetto\."/m);
});
