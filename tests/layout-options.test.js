import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPreamble } from '../src/lib/preamble.js';
import { normalizeHeadingLevels } from '../src/lib/session.js';

test('genera le nuove opzioni di impaginazione localmente', () => {
  const preamble = buildPreamble({
    textsize: 'large',
    orientation: 'landscape',
    margin: 'narrow',
    columns: 'three',
    headingalign: 'center',
    indent: 'small',
    extras: ['hyphenate', 'pagenums'],
  });
  assert.match(preamble, /flipped: true/);
  assert.match(preamble, /margin: 2cm/);
  assert.match(preamble, /columns: 3/);
  assert.match(preamble, /size: 12pt/);
  assert.match(preamble, /hyphenate: true/);
  assert.match(preamble, /align\(center, it\)/);
  assert.match(preamble, /first-line-indent: 0.7em/);
});

test('usa la numerazione per ricostruire la gerarchia dei titoli OCR', () => {
  const source = '# Opera\n\n# 2 Capitolo\n\n# 2.3 Sezione\n\n# 2.3.1 Sottosezione';
  const normalized = normalizeHeadingLevels(source);
  assert.match(normalized, /^# Opera$/m);
  assert.match(normalized, /^# 2 Capitolo$/m);
  assert.match(normalized, /^## 2\.3 Sezione$/m);
  assert.match(normalized, /^### 2\.3\.1 Sottosezione$/m);
});
