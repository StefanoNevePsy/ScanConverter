import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ITEM_INDENT,
  lineRange,
  listMarker,
  toList,
  clearList,
  indentIntoItem,
  endList,
  describeSelection,
} from '../src/lib/listEdit.js';

test('lineRange estende la selezione ai confini di riga', () => {
  const text = 'prima riga\nseconda riga\nterza riga';
  // Selezione a metà della parola «conda»: deve diventare tutta la riga.
  const start = text.indexOf('conda');
  const { from, to } = lineRange(text, start, start + 5);
  assert.equal(text.slice(from, to), 'seconda riga');
});

test('lineRange arriva a fine testo quando manca il ritorno a capo finale', () => {
  const text = 'unica riga senza a capo';
  const { from, to } = lineRange(text, 3, 6);
  assert.equal(from, 0);
  assert.equal(to, text.length);
});

test('lineRange non ingloba la riga dopo quando la selezione finisce sul ritorno a capo', () => {
  // Il doppio clic su una riga seleziona spesso fino al `\n` incluso: senza
  // questa regola l'azione toccherebbe anche la riga successiva.
  const text = 'alfa\nbeta\ngamma';
  const { from, to } = lineRange(text, 0, 5);
  assert.equal(text.slice(from, to), 'alfa\n');
});

test('listMarker riconosce i marcatori e ignora il testo normale', () => {
  assert.equal(listMarker('testo qualunque'), null);
  assert.deepEqual(listMarker('- voce'), { indent: '', marker: '-', kind: 'bullet', length: 2 });
  assert.deepEqual(listMarker('  + voce'), { indent: '  ', marker: '+', kind: 'bullet', length: 4 });
  assert.deepEqual(listMarker('3. voce'), { indent: '', marker: '3.', kind: 'ordered', length: 3 });
  assert.deepEqual(listMarker('12) voce'), { indent: '', marker: '12)', kind: 'ordered', length: 4 });
  // Senza spazio dopo il marcatore non è un elenco: «1.5 mm» resta testo.
  assert.equal(listMarker('1.5 mm di margine'), null);
});

test('toList trasforma le righe selezionate in elenco puntato', () => {
  const text = 'intro\nalfa\nbeta\ncoda';
  const result = toList(text, text.indexOf('alfa'), text.indexOf('beta') + 4, 'bullet');
  assert.equal(result.value, 'intro\n- alfa\n- beta\ncoda');
  // La selezione restituita copre esattamente le righe trasformate.
  assert.equal(result.value.slice(result.start, result.end), '- alfa\n- beta');
});

test('toList numera progressivamente e salta le righe vuote', () => {
  const text = 'alfa\n\nbeta\n\ngamma';
  const result = toList(text, 0, text.length, 'ordered');
  assert.equal(result.value, '1. alfa\n\n2. beta\n\n3. gamma');
});

test('toList accetta il marcatore «1)» dell’autore', () => {
  const text = 'alfa\nbeta';
  const result = toList(text, 0, text.length, 'ordered', { marker: '1)' });
  assert.equal(result.value, '1) alfa\n2) beta');
});

test('toList rinumera un elenco già esistente invece di accumulare marcatori', () => {
  const text = '7. alfa\n9. beta\n- gamma';
  const result = toList(text, 0, text.length, 'ordered');
  assert.equal(result.value, '1. alfa\n2. beta\n3. gamma');
});

test('toList converte un elenco numerato in puntato', () => {
  const text = '1. alfa\n2. beta';
  const result = toList(text, 0, text.length, 'bullet');
  assert.equal(result.value, '- alfa\n- beta');
});

test('toList azzera il rientro delle righe che trasforma in voci', () => {
  // Una riga rientrata è il corpo di un'altra voce: promuoverla a voce
  // significa portarla al livello dell'elenco, altrimenti Typst la annida.
  const text = '  testo rientrato\n  altro rientrato';
  const result = toList(text, 0, text.length, 'bullet');
  assert.equal(result.value, '- testo rientrato\n- altro rientrato');
});

test('clearList toglie i marcatori lasciando il testo', () => {
  const text = '- alfa\n2) beta\ntesto';
  const result = clearList(text, 0, text.length);
  assert.equal(result.value, 'alfa\nbeta\ntesto');
});

test('indentIntoItem rientra le righe non vuote e lascia stare quelle vuote', () => {
  const text = '1. domanda\nrisposta\n\nseguito';
  const result = indentIntoItem(text, text.indexOf('risposta'), text.length);
  assert.equal(result.value, `1. domanda\n${ITEM_INDENT}risposta\n\n${ITEM_INDENT}seguito`);
});

test('indentIntoItem e endList sono l’uno l’inverso dell’altro', () => {
  const text = 'alfa\nbeta';
  const nested = indentIntoItem(text, 0, text.length);
  const back = endList(nested.value, nested.start, nested.end);
  assert.equal(back.value, text);
});

test('endList toglie un solo livello di rientro per volta', () => {
  const text = '    riga a due livelli';
  const once = endList(text, 0, text.length);
  assert.equal(once.value, '  riga a due livelli');
  const twice = endList(once.value, once.start, once.end);
  assert.equal(twice.value, 'riga a due livelli');
});

test('endList tollera un rientro parziale senza mangiare il testo', () => {
  const text = ' riga con un solo spazio';
  const result = endList(text, 0, text.length);
  assert.equal(result.value, 'riga con un solo spazio');
});

test('endList non tocca una riga già a margine', () => {
  const text = 'riga a margine';
  const result = endList(text, 0, text.length);
  assert.equal(result.value, text);
});

test('describeSelection riporta lo stato delle righe selezionate', () => {
  assert.deepEqual(describeSelection('- alfa\n- beta', 0, 13), {
    bullet: true, ordered: false, indented: false, lines: 2,
  });
  assert.deepEqual(describeSelection('1. alfa\n2. beta', 0, 15), {
    bullet: false, ordered: true, indented: false, lines: 2,
  });
  // Elenco misto: nessuno dei due stati è attivo.
  assert.deepEqual(describeSelection('- alfa\n1. beta', 0, 14), {
    bullet: false, ordered: false, indented: false, lines: 2,
  });
  assert.deepEqual(describeSelection('  alfa\n  beta', 0, 13), {
    bullet: false, ordered: false, indented: true, lines: 2,
  });
});

test('describeSelection ignora le righe vuote nel conteggio', () => {
  const state = describeSelection('- alfa\n\n- beta', 0, 14);
  assert.equal(state.lines, 2);
  assert.equal(state.bullet, true);
});

test('describeSelection su selezione vuota non propone nessuno stato', () => {
  assert.deepEqual(describeSelection('\n\n', 0, 2), {
    bullet: false, ordered: false, indented: false, lines: 0,
  });
});

test('il ciclo puntato → numerato → nessuno torna al testo di partenza', () => {
  const text = 'intro\nprima voce\nseconda voce\nfine';
  const from = text.indexOf('prima');
  const to = text.indexOf('seconda voce') + 'seconda voce'.length;
  const bullet = toList(text, from, to, 'bullet');
  const ordered = toList(bullet.value, bullet.start, bullet.end, 'ordered');
  assert.equal(ordered.value, 'intro\n1. prima voce\n2. seconda voce\nfine');
  const cleared = clearList(ordered.value, ordered.start, ordered.end);
  assert.equal(cleared.value, text);
});
