import test from 'node:test';
import assert from 'node:assert/strict';

import {
  changedRegion,
  splitPdfPages,
  joinPdfPages,
  windowPages,
  canVerifyIncrementally,
  verifyPdfText,
  MAX_INCREMENTAL_CHARS,
} from '../src/lib/verifyWindow.js';

test('changedRegion isola la parte davvero cambiata', () => {
  const before = 'uno due tre quattro cinque';
  const after = 'uno due TRE quattro cinque';
  const region = changedRegion(before, after);
  assert.equal(after.slice(region.start, region.end), 'TRE');
  assert.equal(before.slice(region.start, region.oldEnd), 'tre');
});

test('changedRegion riconosce un’aggiunta e una cancellazione', () => {
  const aggiunta = changedRegion('uno tre', 'uno due tre');
  assert.equal('uno due tre'.slice(aggiunta.start, aggiunta.end).trim(), 'due');
  const tolta = changedRegion('uno due tre', 'uno tre');
  assert.equal(tolta.start < tolta.oldEnd, true);
});

test('changedRegion dice «niente» quando i testi coincidono', () => {
  assert.equal(changedRegion('uguale', 'uguale'), null);
});

test('le pagine si separano e si ricompongono senza perdite', () => {
  const estratto = [
    '<!-- pagina 1 -->',
    '',
    'Testo della prima pagina.',
    '',
    '<!-- pagina 2 -->',
    '',
    'Testo della seconda pagina.',
  ].join('\n');
  const pagine = splitPdfPages(estratto);
  assert.deepEqual(pagine.map((p) => p.page), [1, 2]);
  assert.equal(pagine[1].text, 'Testo della seconda pagina.');
  assert.equal(joinPdfPages(pagine), estratto.replace(/\n{3,}/gu, '\n\n').trim());
});

test('un estratto di una pagina sola non ha marcatori e resta tale', () => {
  const pagine = splitPdfPages('Documento di una pagina.');
  assert.deepEqual(pagine, [{ page: 1, text: 'Documento di una pagina.' }]);
  assert.equal(joinPdfPages(pagine), 'Documento di una pagina.');
});

test('la finestra è larga e non esce dai bordi', () => {
  // 387 pagine: il 6% fa 24 pagine per lato, perché la corrispondenza
  // sorgente↔pagina deriva fino a una quindicina di pagine.
  const centro = windowPages(0.5, 0.5, 387);
  assert.equal(centro.from, 194 - 24);
  assert.equal(centro.to, 194 + 24);
  const inizio = windowPages(0, 0.01, 387);
  assert.equal(inizio.from, 1);
  const fine = windowPages(0.99, 1, 387);
  assert.equal(fine.to, 387);
});

test('su un documento corto la finestra copre tutto: nessun risparmio, nessun rischio', () => {
  const w = windowPages(0.5, 0.5, 8);
  assert.equal(w.from, 1);
  assert.equal(w.to, 8);
  assert.deepEqual(windowPages(0.5, 0.5, 0), { from: 0, to: 0 });
});

const preambolo = '#set page(paper: "a4")\n#set text(size: 11pt)\n\n';

test('una modifica nel corpo apre la via incrementale', () => {
  const vecchio = `${preambolo}Primo paragrafo.\n\nSecondo paragrafo.`;
  const nuovo = `${preambolo}Primo paragrafo.\n\nSecondo paragrafo corretto.`;
  const esito = canVerifyIncrementally({ oldSource: vecchio, newSource: nuovo, pageTexts: ['a', 'b'] });
  assert.equal(esito.ok, true);
});

test('una modifica nel preambolo impone la verifica completa', () => {
  const vecchio = `${preambolo}Testo.`;
  const nuovo = `#set page(paper: "a5")\n#set text(size: 11pt)\n\nTesto.`;
  const esito = canVerifyIncrementally({ oldSource: vecchio, newSource: nuovo, pageTexts: ['a'] });
  assert.equal(esito.ok, false);
  assert.match(esito.reason, /preambolo/);
});

test('una modifica enorme impone la verifica completa', () => {
  const vecchio = `${preambolo}Testo.`;
  const nuovo = `${preambolo}Testo.${'x'.repeat(MAX_INCREMENTAL_CHARS + 1)}`;
  const esito = canVerifyIncrementally({ oldSource: vecchio, newSource: nuovo, pageTexts: ['a'] });
  assert.equal(esito.ok, false);
  assert.match(esito.reason, /troppo ampia/);
});

test('senza una lettura precedente non c’è niente da riusare', () => {
  const esito = canVerifyIncrementally({ oldSource: 'a', newSource: 'b', pageTexts: [] });
  assert.equal(esito.ok, false);
});

test('una cancellazione lunga vale quanto un’aggiunta lunga', () => {
  const vecchio = `${preambolo}Testo.${'x'.repeat(MAX_INCREMENTAL_CHARS + 1)}`;
  const nuovo = `${preambolo}Testo.`;
  const esito = canVerifyIncrementally({ oldSource: vecchio, newSource: nuovo, pageTexts: ['a'] });
  assert.equal(esito.ok, false);
  assert.match(esito.reason, /troppo ampia/);
});

/* Un PDF finto: pagine di testo, con la lettura che registra cosa le è stato
   chiesto — così si vede se la verifica ha davvero riletto poco. */
function fintoPdf(pagine) {
  const richieste = [];
  const read = async (numeri) => {
    richieste.push(numeri ? [...numeri] : 'tutte');
    const scelte = numeri
      ? pagine.filter((_, i) => numeri.includes(i + 1))
      : pagine;
    const numeriScelti = numeri || pagine.map((_, i) => i + 1);
    return numeriScelti
      .map((n, i) => `<!-- pagina ${n} -->\n\n${scelte[i]}`)
      .join('\n\n');
  };
  return { read, richieste };
}

const testo = (n) => `Testo della pagina ${n} con abbastanza parole da distinguerla.`;

test('senza lettura precedente si legge tutto', async () => {
  const pagine = [testo(1), testo(2), testo(3)];
  const { read, richieste } = fintoPdf(pagine);
  const esito = await verifyPdfText({ source: 'x', previous: null, read });
  assert.equal(esito.incremental, false);
  assert.deepEqual(richieste, ['tutte']);
});

test('una parola cambiata rilegge solo la finestra e riusa il resto', async () => {
  const pagine = Array.from({ length: 120 }, (_, i) => testo(i + 1));
  const precedente = {
    source: `${preambolo}${'a'.repeat(5000)}parola${'b'.repeat(5000)}`,
    pages: pagine.map((text, i) => ({ page: i + 1, text })),
  };
  const nuove = [...pagine];
  nuove[59] = 'Testo della pagina 60 CORRETTO con abbastanza parole.';
  const { read, richieste } = fintoPdf(nuove);
  const esito = await verifyPdfText({
    source: precedente.source.replace('parola', 'PAROLA'),
    previous: precedente,
    read,
  });
  assert.equal(esito.incremental, true);
  assert.equal(richieste.length, 1);
  assert.equal(richieste[0].length < 120, true, 'deve leggere meno di tutto');
  // Il testo ricomposto contiene la pagina riletta e quelle riusate.
  assert.match(esito.text, /pagina 60 CORRETTO/);
  assert.match(esito.text, /Testo della pagina 1 con/);
});

test('se la rimpaginazione tocca il bordo della finestra si rilegge tutto', async () => {
  const pagine = Array.from({ length: 120 }, (_, i) => testo(i + 1));
  const precedente = {
    source: `${preambolo}${'a'.repeat(5000)}parola${'b'.repeat(5000)}`,
    pages: pagine.map((text, i) => ({ page: i + 1, text })),
  };
  // Tutte le pagine sono cambiate: anche i bordi non combaciano più.
  const nuove = pagine.map((t) => `${t} spostato`);
  const { read, richieste } = fintoPdf(nuove);
  const esito = await verifyPdfText({
    source: precedente.source.replace('parola', 'PAROLA'),
    previous: precedente,
    read,
  });
  assert.equal(esito.incremental, false);
  assert.equal(richieste.length, 2, 'prima la finestra, poi tutto');
  assert.equal(richieste[1], 'tutte');
});

test('su un documento corto non vale la pena: si legge tutto una volta sola', async () => {
  const pagine = [testo(1), testo(2), testo(3)];
  const precedente = {
    source: `${preambolo}parola`,
    pages: pagine.map((text, i) => ({ page: i + 1, text })),
  };
  const { read, richieste } = fintoPdf(pagine);
  const esito = await verifyPdfText({
    source: `${preambolo}PAROLA`,
    previous: precedente,
    read,
  });
  assert.equal(esito.incremental, false);
  assert.deepEqual(richieste, ['tutte']);
});
