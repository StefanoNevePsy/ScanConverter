import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatTypstDiagnostics,
  normalizeTypstDiagnostics,
  parseTypstRange,
} from '../src/lib/typstdiag.js';

test('interpreta gli intervalli riga-colonna del compilatore Typst', () => {
  assert.deepEqual(parseTypstRange('12:4-13:8'), {
    start: { line: 13, column: 5 },
    end: { line: 14, column: 9 },
  });
  assert.equal(parseTypstRange('span-opaco'), null);
});

test('normalizza diagnostiche full e unix senza perdere la posizione', () => {
  const full = normalizeTypstDiagnostics([{
    path: '/main.typ',
    severity: 'error',
    range: '42:7-42:8',
    message: 'unclosed delimiter',
  }]);
  assert.equal(full[0].line, 43);
  assert.equal(full[0].column, 8);

  const firstLine = normalizeTypstDiagnostics({
    severity: 'error',
    range: '0:5-0:6',
    message: 'unclosed delimiter',
  });
  assert.equal(firstLine[0].line, 1);
  assert.equal(firstLine[0].column, 6);

  const unix = normalizeTypstDiagnostics('main.typ:9:2-9:5: error: unknown variable: foo');
  assert.equal(unix[0].line, 9);
  assert.equal(unix[0].message, 'unknown variable: foo');
  assert.match(formatTypstDiagnostics(unix), /riga 9, colonna 2/);
});
