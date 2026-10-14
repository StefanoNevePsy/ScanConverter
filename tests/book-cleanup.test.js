import test from 'node:test';
import assert from 'node:assert/strict';
import { removeRepeatedRunningHeads, mergeChapterOpeners } from '../src/lib/bookCleanup.js';
import { headingShape } from '../src/lib/strict.js';

// Dal «Manuale SST»: testatina «3. DALLA TEORIA ALLA PRATICA» su ogni pagina.
test('testatina corrente ripetuta: tolta solo in cima alle pagine', () => {
  const words = ['saluto', 'ascolto', 'gioia', 'rabbia', 'paura'];
  const pages = [22, 23, 24, 25, 26].map((n, i) =>
    `<!-- pagina ${n} -->\n## 3. DALLA TEORIA ALLA PRATICA\n\nTesto della pagina ${n} sul ${words[i]}.`);
  const md = `${pages.join('\n\n')}\n\nNel capitolo «3. Dalla teoria alla pratica» si dice altro.`;
  const res = removeRepeatedRunningHeads(md);
  assert.equal(res.removed, 5);
  assert.doesNotMatch(res.text, /## 3\. DALLA TEORIA/);
  assert.match(res.text, /<!-- pagina 24 -->\nTesto della pagina 24 sul gioia/);
  assert.match(res.text, /Nel capitolo «3\. Dalla teoria alla pratica»/);
});

test('apertura di capitolo spezzata in tre blocchi', () => {
  const md = '<!-- pagina 1 -->\nCAPITOLO\n\n3\n\n# Dalla teoria alla pratica\n\nR. Castaldo, S. Bari';
  // il segno di pagina sta col primo blocco e deve restare
  const res = mergeChapterOpeners(md);
  assert.equal(res.merged, 1);
  assert.match(res.text, /^<!-- pagina 1 -->\n# Capitolo 3 – Dalla teoria alla pratica\n\nR\. Castaldo/);
});

test('etichette numerate come titoli dello stesso tipo', () => {
  assert.equal(headingShape('ABILITÀ 1: IL SALUTO').signature, headingShape('ABILITÀ 2: L’ASCOLTO').signature);
  assert.notEqual(headingShape('INCONTRO 1: INTRODUZIONE').signature, headingShape('ABILITÀ 1: IL SALUTO').signature);
});
