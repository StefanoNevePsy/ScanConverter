import test from 'node:test';
import assert from 'node:assert/strict';

import { setChapterOpeners, isOpener, stripOpener } from '../src/lib/bookStyle.js';

const doc = [
  '= Le lealtà invisibili',
  '',
  'Nel mezzo del cammino terapeutico la famiglia porta con sé un registro.',
  '',
  'Il secondo paragrafo resta prosa normale.',
  '',
  '== Una sezione interna',
  '',
  'Anche questo resta prosa: il maiuscoletto è per i capitoli, non per le sezioni.',
  '',
  '= Secondo capitolo',
  '',
  'Ogni famiglia ha un modo suo di tenere i conti.',
].join('\n');

test('marca il primo paragrafo di ogni capitolo, e solo quello', () => {
  const marked = setChapterOpeners(doc, true).split('\n');
  assert.equal(marked[2], '#apertura[Nel mezzo del cammino terapeutico la famiglia porta con sé un registro.]');
  assert.equal(marked[4], 'Il secondo paragrafo resta prosa normale.');
  assert.equal(marked[8], 'Anche questo resta prosa: il maiuscoletto è per i capitoli, non per le sezioni.');
  assert.equal(marked[12], '#apertura[Ogni famiglia ha un modo suo di tenere i conti.]');
});

test('spegnere lo stile riporta il testo esattamente com’era', () => {
  const marked = setChapterOpeners(doc, true);
  assert.equal(setChapterOpeners(marked, false), doc);
});

test('applicarlo due volte non annida i marcatori', () => {
  const once = setChapterOpeners(doc, true);
  assert.equal(setChapterOpeners(once, true), once);
});

test('salta gli elementi che non sono prosa fra titolo e testo', () => {
  const source = [
    '= Capitolo con figura',
    '',
    '#figure(image("/figures/fig-1.png"))',
    '',
    '// pagina 12',
    '',
    'Il vero primo paragrafo del capitolo comincia qui.',
  ].join('\n');
  const marked = setChapterOpeners(source, true).split('\n');
  assert.equal(marked[2], '#figure(image("/figures/fig-1.png"))');
  assert.equal(marked[4], '// pagina 12');
  assert.equal(marked[6], '#apertura[Il vero primo paragrafo del capitolo comincia qui.]');
});

test('non marca un elenco che apre il capitolo', () => {
  const source = '= Capitolo\n\n1. prima voce\n2. seconda voce\n\nParagrafo dopo l’elenco.';
  const marked = setChapterOpeners(source, true);
  assert.equal(marked, source);
});

test('un capitolo senza testo dopo non rompe niente', () => {
  const source = '= Solo un titolo\n';
  assert.equal(setChapterOpeners(source, true), source);
});

test('isOpener e stripOpener riconoscono e sciolgono il marcatore', () => {
  assert.equal(isOpener('#apertura[Testo.]'), true);
  assert.equal(isOpener('#figure(image("x.png"))'), false);
  assert.equal(stripOpener('#apertura[Testo.]'), 'Testo.');
  assert.equal(stripOpener('Testo normale.'), 'Testo normale.');
});

test('il marcatore convive con la marcatura Typst dentro il paragrafo', () => {
  const source = '= Capitolo\n\nUn testo con _corsivo_ e #footnote[una nota] dentro.';
  const marked = setChapterOpeners(source, true);
  assert.match(marked, /#apertura\[Un testo con _corsivo_ e #footnote\[una nota\] dentro\.\]/);
  assert.equal(setChapterOpeners(marked, false), source);
});
