/*
  Elenchi con il corpo dentro le voci.

  Caso reale, da «Ipotizzazione - circolarità - neutralità» (Selvini Palazzoli
  e altri): un elenco numerato di cinque modi di indagare le relazioni, dove
  ogni voce è seguita da una spiegazione e da una trascrizione di seduta con
  più interlocutori.

  Nell'esito prodotto dalla versione precedente dell'app le cinque voci erano
  numerate «1.» tutte e cinque, e la trascrizione stava a margine sinistro,
  indistinguibile dal testo corrente.

  La causa, verificata con il compilatore Typst vero: il renderer convertiva
  ogni voce in `+`, cioè numerazione automatica, e in Typst un `+` che segue
  un paragrafo apre un elenco NUOVO — quindi riparte da 1.
*/

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildStrictDocument,
  detectEnumMarker,
  markdownToStrictTypst,
  planListNesting,
} from '../src/lib/strict.js';
import { normalizeLayoutOptions, buildPreamble } from '../src/lib/preamble.js';

/** Il documento reale, come esce dall'OCR: un paragrafo per blocco. */
const CASO = [
  'Le relazioni dovranno essere indagate:',
  '1. In termini di comportamenti interattivi specifici in circostanze specifiche.',
  'Si veda, come esempio, la transazione iniziata dal terapista con il figlio maggiore.',
  'TERAPISTA (rivolto al fratello maggiore): Quando Lorenzo perde il controllo, papà che cosa fa?',
  '2. In termini di differenze nei comportamenti entro rapporti specifici.',
  'FIGLIO: Viviamo insieme coi nonni che sono dei gran rompiscatole.',
  'TERAPISTA: Cosa fanno per rompere le scatole?',
  '3. In termini di graduatoria dei vari membri della famiglia.',
  'TERAPISTA: Classifica i vari membri in base alla tendenza a restare in casa la domenica.',
  '4. in termini di mutamento nel rapporto prima e dopo un avvenimento preciso.',
  'SISSI: Oh, dopo, dopo! La mamma si arrabbia molto di più.',
  '5. in termini di differenze rispetto a circostanze ipotetiche.',
  'TERAPISTA: Se di tutti voi figli ne dovesse restare in casa uno, quale andrebbe meglio per papà?',
  'Le metodologie qui presentate sono da noi utilmente applicate anche nella prima seduta.',
].join('\n\n');

/* ------------------------------------------------------------ numerazione */

test('le cinque voci mantengono i loro numeri invece di ripartire da 1', () => {
  const typst = markdownToStrictTypst(CASO);
  const numeri = [...typst.matchAll(/^(\d+)\. In termini|^(\d+)\. in termini/gm)]
    .map((m) => Number(m[1] || m[2]));
  assert.deepEqual(numeri, [1, 2, 3, 4, 5]);
  assert.equal(/^\+ /m.test(typst), false, 'nessuna numerazione automatica');
});

test('un elenco non interrotto continua a funzionare', () => {
  const typst = markdownToStrictTypst('1. primo\n2. secondo\n3. terzo');
  assert.match(typst, /^1\. primo$/m);
  assert.match(typst, /^2\. secondo$/m);
  assert.match(typst, /^3\. terzo$/m);
});

test('gli elenchi puntati restano puntati', () => {
  const typst = markdownToStrictTypst('- primo\n- secondo');
  assert.match(typst, /^- primo$/m);
  assert.match(typst, /^- secondo$/m);
});

test('il numero scritto nell’originale non viene reinventato', () => {
  // Un elenco che riprende da 7 dopo un’interruzione di pagina deve restare a
  // 7: rinumerare da 1 contraddirebbe la fonte.
  const typst = markdownToStrictTypst('7. settima voce\n\nUn paragrafo.\n\n8. ottava voce');
  assert.match(typst, /^7\. settima voce$/m);
  assert.match(typst, /^8\. ottava voce$/m);
});

/* -------------------------------------------------------------- rientri */

test('la trascrizione finisce dentro la voce che la precede', () => {
  const typst = markdownToStrictTypst(CASO);
  const righe = typst.split('\n').filter((l) => l.trim());
  const voce = righe.findIndex((l) => /^2\. In termini/.test(l));
  assert.ok(voce > 0);
  assert.match(righe[voce + 1], /^ {2}FIGLIO:/, 'la battuta è rientrata sotto la voce');
  assert.match(righe[voce + 2], /^ {2}TERAPISTA:/);
});

test('la spiegazione prima della trascrizione è anch’essa dentro la voce', () => {
  const typst = markdownToStrictTypst(CASO);
  assert.match(typst, /^ {2}Si veda, come esempio/m);
});

test('il paragrafo che chiude la sezione resta FUORI dall’elenco', () => {
  // È il caso difficile: l'ultima voce non è delimitata da nessuna voce
  // successiva. Si prosegue finché sono battute di dialogo e si smette alla
  // prosa — qui «Le metodologie qui presentate…».
  const typst = markdownToStrictTypst(CASO);
  assert.match(typst, /^Le metodologie qui presentate/m, 'a margine sinistro, non rientrato');
});

test('l’ultima voce si porta dietro il suo esempio di dialogo', () => {
  const typst = markdownToStrictTypst(CASO);
  assert.match(typst, /^ {2}TERAPISTA: Se di tutti voi figli/m);
});

/* --------------------------------------------- limiti e casi di guardia */

test('un titolo interrompe l’elenco e non viene mai rientrato', () => {
  const md = ['1. prima voce', 'Del testo qualsiasi.', '## Una sezione nuova', '1. altra voce'].join('\n\n');
  const typst = markdownToStrictTypst(md);
  assert.match(typst, /^== Una sezione nuova$/m, '«##» diventa «==»');
  assert.equal(/^ {2}=+ /m.test(typst), false, 'un titolo non viene mai rientrato');
});

test('una figura fra due voci non viene inghiottita nell’elenco', () => {
  const md = ['1. prima voce', '![Figura 1](/figures/fig-1.png)', '2. seconda voce'].join('\n\n');
  const nested = planListNesting(md.split(/\n{2,}/));
  assert.equal(nested.has(1), false, 'la figura resta un blocco autonomo');
});

test('voci consecutive non hanno corpo da rientrare', () => {
  assert.equal(planListNesting(['1. prima', '2. seconda', '3. terza']).size, 0);
});

test('un elenco lontanissimo dal successivo non inghiotte mezzo capitolo', () => {
  const blocks = ['1. una voce', ...Array.from({ length: 40 }, (_, i) => `Paragrafo ${i}.`), '2. altra voce'];
  const nested = planListNesting(blocks);
  assert.equal(nested.size, 0, 'oltre la distanza massima non è più il corpo di una voce');
});

test('dopo l’ultima voce la prosa interrompe subito il rientro', () => {
  const blocks = ['3. ultima voce', 'Un paragrafo di prosa normale.', 'TERAPISTA: una battuta.'];
  const nested = planListNesting(blocks);
  assert.equal(nested.has(1), false);
  assert.equal(nested.has(2), false, 'una volta chiuso l’elenco non si riapre');
});

test('i marcatori di pagina non interrompono il corpo di una voce', () => {
  const blocks = ['3. ultima voce', '<!-- pagina 7 -->', 'TERAPISTA: una battuta.'];
  const nested = planListNesting(blocks);
  assert.equal(nested.has(2), true, 'la battuta appartiene ancora alla voce');
});

test('nessun testo viene alterato, solo rientri e numeri', () => {
  const typst = markdownToStrictTypst(CASO);
  const parole = (s) => (s.match(/[\p{L}\p{N}’']+/gu) || []).join(' ');
  const attese = parole(CASO.replace(/^\d+\.\s+/gm, ''));
  const ottenute = parole(typst.replace(/^\s*\d+\.\s+/gm, ''));
  assert.equal(ottenute, attese);
});

/* ------------------------------------------ il marcatore dell’autore */

test('la parentesi dell’autore viene riconosciuta', () => {
  // La pagina 16 dell’originale numera le voci «1)» «2)» «3)», non «1.».
  assert.equal(detectEnumMarker('1) prima\n\nUn paragrafo.\n\n2) seconda'), '1)');
  assert.equal(detectEnumMarker('1. prima\n\n2. seconda'), '1.');
  assert.equal(detectEnumMarker('Nessun elenco qui.'), '1.');
});

test('con marcatori misti vince quello prevalente', () => {
  assert.equal(detectEnumMarker('1) a\n2) b\n3) c\n1. d'), '1)');
});

test('la parentesi finisce nel preambolo, non nel testo', () => {
  const md = ['Le relazioni dovranno essere indagate:', '1) prima voce', 'Del testo.', '2) seconda voce'].join('\n\n');
  const { preamble, body } = buildStrictDocument(md);
  assert.match(preamble, /#set enum\(numbering: "1\)"\)/);
  // Nel corpo resta la forma «1.»: è l’unica che Typst riconosce come elenco.
  // Verificato col compilatore: «1)» resterebbe testo, senza numerazione né
  // rientro di continuazione.
  assert.match(body, /^1\. prima voce$/m);
  assert.match(body, /^2\. seconda voce$/m);
});

test('un documento con i punti non aggiunge la riga sugli elenchi', () => {
  const { preamble } = buildStrictDocument('1. prima\n\nDel testo.\n\n2. seconda');
  assert.equal(/#set enum/.test(preamble), false, 'il default non va dichiarato');
});

test('una ristilizzazione non azzera il marcatore dedotto', () => {
  // Il pannello rimanda solo le opzioni che mostra: fondendole sopra quelle
  // correnti, ciò che è stato dedotto dal documento sopravvive.
  const dedotte = normalizeLayoutOptions({ enumNumbering: '1)' });
  const dopoRistile = normalizeLayoutOptions({ ...dedotte, font: 'newcm', paper: 'a5' });
  assert.equal(dopoRistile.enumNumbering, '1)');
  assert.match(buildPreamble(dopoRistile, {}), /#set enum\(numbering: "1\)"\)/);

  // Senza la fusione — cioè passando la sola selezione — si perderebbe.
  assert.equal(normalizeLayoutOptions({ font: 'newcm', paper: 'a5' }).enumNumbering, '1.');
});
