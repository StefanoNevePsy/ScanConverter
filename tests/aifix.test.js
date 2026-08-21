import test from 'node:test';
import assert from 'node:assert/strict';
import { applyFixes, focusCodeForRepair, repairExcerpt } from '../src/lib/aifix.js';

test('applica una patch AI con differenze nella sola spaziatura', () => {
  const source = 'Prima riga.\nPer _circolarità_ intendiamo la capacità.\nUltima riga.';
  const result = applyFixes(source, [{
    find: 'Per   _circolarità_\nintendiamo la capacità.',
    replace: 'Per #emph[circolarità] intendiamo la capacità.',
  }]);
  assert.equal(result.applied.length, 1);
  assert.match(result.code, /Per #emph\[circolarità\] intendiamo/);
});

test('non applica una patch flessibile ambigua o priva di modifiche', () => {
  const ambiguous = applyFixes('testo uguale\n\ntesto uguale', [{
    find: 'testo   uguale',
    replace: 'testo corretto',
  }]);
  assert.equal(ambiguous.applied.length, 0);
  assert.equal(ambiguous.code, 'testo uguale\n\ntesto uguale');

  const noOp = applyFixes('testo', [{ find: 'testo', replace: 'testo' }]);
  assert.equal(noOp.applied.length, 0);
});

test('limita il prompt AI attorno alla riga dell’errore nei documenti lunghi', () => {
  const source = Array.from({ length: 1000 }, (_, i) => `Riga ${i + 1} con contenuto.`).join('\n');
  const focused = focusCodeForRepair(source, { line: 700 }, 1200);
  assert.ok(focused.length <= 1300);
  assert.match(focused, /Riga 700 con contenuto/);
  assert.doesNotMatch(focused, /Riga 1 con contenuto/);
});

test('non applica una find esatta ambigua ma usa lo scope localizzato', () => {
  const source = 'frase ripetuta\n\nfrase ripetuta';
  const global = applyFixes(source, [{ find: 'frase ripetuta', replace: 'frase corretta' }]);
  assert.equal(global.applied.length, 0);
  assert.equal(global.code, source);

  const start = source.lastIndexOf('frase ripetuta');
  const scoped = applyFixes(
    source,
    [{ find: 'frase ripetuta', replace: 'frase corretta' }],
    { scope: { start, end: source.length } },
  );
  assert.equal(scoped.applied.length, 1);
  assert.equal(scoped.code, 'frase ripetuta\n\nfrase corretta');
});

test('lo scope AI conserva offset e numeri di riga originali', () => {
  const source = Array.from({ length: 200 }, (_, i) => `Riga ${i + 1} contenuto.`).join('\n');
  const excerpt = repairExcerpt(source, { line: 150 }, 500);
  assert.ok(excerpt.start > 0);
  assert.ok(excerpt.end < source.length);
  assert.equal(source.slice(excerpt.start, excerpt.end), excerpt.text);
  assert.ok(excerpt.startLine < 150 && excerpt.endLine > 150);
});
