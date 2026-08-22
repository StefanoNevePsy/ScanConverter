import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPreamble, ensureExplicitHyphenation } from '../src/lib/preamble.js';
import { chunkTextRanges, normalizeHeadingLevels } from '../src/lib/session.js';

test('i chunk selezionabili conservano testo e offset byte per byte', () => {
  const source = `Primo paragrafo con accenti: perché è così.\n\n\n${'Seconda frase abbastanza lunga. '.repeat(30)}\n\nCoda.`;
  const ranges = chunkTextRanges(source, 500);
  assert.equal(ranges.map((range) => range.text).join(''), source);
  for (const range of ranges) assert.equal(range.text, source.slice(range.start, range.end));
});

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
  assert.match(preamble, /show heading: set align\(center\)/);
  assert.match(preamble, /first-line-indent: 0.7em/);
});

test('normalizza margini e tipografia granulari senza accettare valori fuori scala', () => {
  const preamble = buildPreamble({
    paper: 'custom',
    pageWidthMm: 170,
    pageHeightMm: 240,
    marginMode: 'mirrored',
    marginTopCm: 2.1,
    marginBottomCm: 2.2,
    marginInsideCm: 3.4,
    marginOutsideCm: 1.8,
    binding: 'left',
    bodySizePt: 999,
    leadingEm: 0.8,
    paragraphSpacingEm: 0.6,
    indentEm: 1.5,
    indentAll: true,
    heading1Pt: 24,
    headingNumbering: 'decimal-dot',
    pageNumbering: 'roman-upper',
    pageNumberPosition: 'bottom-right',
    headerMode: 'custom',
    headerText: 'Archivio "A"',
    figureAlign: 'left',
    captionPosition: 'top',
    footnoteSizePt: 8,
  });
  assert.match(preamble, /width: 170mm, height: 240mm/);
  assert.match(preamble, /inside: 3.4cm, outside: 1.8cm/);
  assert.match(preamble, /binding: left/);
  assert.match(preamble, /size: 24pt, weight: 400/);
  assert.doesNotMatch(preamble, /999pt/);
  assert.match(preamble, /first-line-indent: \(amount: 1.5em, all: true\)/);
  assert.match(preamble, /numbering: "I"/);
  assert.match(preamble, /number-align: right \+ bottom/);
  assert.match(preamble, /text\("Archivio \\"A\\""/);
  assert.match(preamble, /figure\.caption\(position: top\)/);
  assert.match(preamble, /footnote\.entry: set text\(size: 8pt\)/);
});

test('disattiva la sillabazione salvo scelta esplicita e migra i vecchi documenti', () => {
  assert.match(buildPreamble({}), /hyphenate: false/);
  assert.match(
    ensureExplicitHyphenation('#set text(font: "Libertinus Serif", lang: "it")\nTesto'),
    /lang: "it", hyphenate: false/,
  );
  assert.match(
    ensureExplicitHyphenation('#set text(hyphenate: true)\nTesto'),
    /hyphenate: true/,
  );
});

test('usa la numerazione per ricostruire la gerarchia dei titoli OCR', () => {
  const source = '# Opera\n\n# 2 Capitolo\n\n# 2.3 Sezione\n\n# 2.3.1 Sottosezione';
  const normalized = normalizeHeadingLevels(source);
  assert.match(normalized, /^# Opera$/m);
  assert.match(normalized, /^# 2 Capitolo$/m);
  assert.match(normalized, /^## 2\.3 Sezione$/m);
  assert.match(normalized, /^### 2\.3\.1 Sottosezione$/m);
});
