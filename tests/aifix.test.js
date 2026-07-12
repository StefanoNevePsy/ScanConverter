import test from 'node:test';
import assert from 'node:assert/strict';
import { applyFixes, focusCodeForRepair } from '../src/lib/aifix.js';

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
