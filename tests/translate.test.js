/*
  Il valore della traduzione sta quasi tutto nel TAGLIO: una frase spezzata a
  metà o un blocco senza antecedenti si traducono male qualunque sia il
  modello. Questi test verificano il taglio, non la traduzione.
*/

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseMarked,
  planTranslation,
  isUnexpectedAdjacentTranslation,
  preservesMarkdownDelimiters,
  preservesMarkdownStructure,
  renderMarked,
  restoreFigurePaths,
  sanitizeTranslationCandidate,
  splitBlocks,
  splitSentences,
} from '../src/lib/translate.js';

test('non spezza le frasi sulle abbreviazioni', () => {
  const text = 'Il modello è descritto in cfr. Bateson 1972. La ripresa è a p. 42 del volume.';
  assert.deepEqual(
    splitSentences(text).map((s) => s.trim()),
    ['Il modello è descritto in cfr. Bateson 1972.', 'La ripresa è a p. 42 del volume.'],
  );
});

test('non spezza le frasi sulle iniziali puntate né sulle date', () => {
  assert.equal(splitSentences('Secondo C. G. Jung la questione è aperta.').length, 1);
  assert.equal(splitSentences('La riunione del 12.4.1998 fu decisiva.').length, 1);
});

test('tiene insieme puntini di sospensione e virgolette di chiusura', () => {
  const parts = splitSentences('«Non lo so…» rispose lui. Poi tacque.');
  assert.equal(parts.length, 2);
  assert.ok(parts[0].includes('rispose lui.'));
});

test('classifica i blocchi e salta quelli senza parole', () => {
  const blocks = splitBlocks('# Titolo\n\nProsa vera.\n\n---\n\n![Fig. 1](figure/f1.png)');
  assert.deepEqual(blocks.map((b) => b.kind), ['heading', 'prose', 'prose', 'figure']);
  assert.deepEqual(blocks.map((b) => b.translate), [true, true, false, true]);
});

test('ogni gruppo resta sotto il limite e non taglia dentro una frase', () => {
  const paragraph = 'Questa è una frase di prova sufficientemente lunga da contare. ';
  const markdown = Array.from({ length: 40 }, (_, i) => `${paragraph}Paragrafo ${i}.`).join('\n\n');
  const groups = planTranslation(markdown, { maxChars: 600, overlap: 1 });
  assert.ok(groups.length > 1, 'il documento va diviso');
  for (const group of groups) {
    const size = group.blocks.reduce((n, b) => n + b.text.length, 0);
    // Un blocco singolo può superare il limite; un gruppo di più blocchi no.
    if (group.blocks.length > 1) assert.ok(size <= 600, `gruppo troppo grande: ${size}`);
    for (const block of group.blocks) {
      assert.ok(/[.!?…]["»”’')\]]?$/.test(block.text.trim()), `blocco troncato: «${block.text}»`);
    }
  }
});

test('un paragrafo più lungo del limite si divide fra le frasi, non dentro', () => {
  const sentences = Array.from({ length: 12 }, (_, i) => `Frase numero ${i} di un paragrafo unico.`);
  const groups = planTranslation(sentences.join(' '), { maxChars: 220, overlap: 0 });
  assert.ok(groups.length > 1);
  const all = groups.flatMap((g) => g.blocks.map((b) => b.text.trim()));
  for (const piece of all) {
    assert.ok(piece.endsWith('.'), `pezzo troncato: «${piece}»`);
  }
  // Nessuna frase persa e nessuna duplicata nel testo da tradurre.
  assert.equal(all.join(' ').split('Frase numero').length - 1, sentences.length);
});

test('ogni gruppo porta il contesto prima e dopo, tranne agli estremi', () => {
  const markdown = Array.from({ length: 12 }, (_, i) => `Paragrafo numero ${i} del documento.`)
    .join('\n\n');
  const groups = planTranslation(markdown, { maxChars: 200, overlap: 2 });
  assert.ok(groups.length >= 3);
  assert.equal(groups[0].before, '', 'il primo gruppo non ha nulla prima');
  assert.equal(groups.at(-1).after, '', 'l’ultimo gruppo non ha nulla dopo');
  for (const group of groups.slice(1)) assert.ok(group.before.trim(), 'contesto precedente assente');
  for (const group of groups.slice(0, -1)) assert.ok(group.after.trim(), 'contesto seguente assente');
});

test('il contesto è fatto di frasi intere', () => {
  const markdown = Array.from({ length: 10 }, (_, i) => `Prima parte ${i}. Seconda parte ${i}.`)
    .join('\n\n');
  for (const group of planTranslation(markdown, { maxChars: 200, overlap: 2 })) {
    for (const piece of [group.before, group.after]) {
      if (piece.trim()) assert.ok(/[.!?…]$/.test(piece.trim()), `contesto troncato: «${piece}»`);
    }
  }
});

test('il contesto non finisce fra i blocchi da tradurre', () => {
  const markdown = Array.from({ length: 8 }, (_, i) => `Paragrafo ${i}.`).join('\n\n');
  const groups = planTranslation(markdown, { maxChars: 200, overlap: 2 });
  for (const group of groups) {
    const ids = group.blocks.map((b) => b.id);
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
  }
  // Ogni blocco compare in esattamente un gruppo: il contesto è in più, non
  // al posto della traduzione.
  const seen = groups.flatMap((g) => g.blocks.map((b) => b.id));
  assert.equal(new Set(seen).size, seen.length);
  assert.equal(seen.length, 8);
});

test('le etichette sopravvivono al giro di andata e ritorno', () => {
  const blocks = [
    { id: 3, text: '# Titolo' },
    { id: 4, text: 'Corpo del\ntesto su due righe.' },
  ];
  const parsed = parseMarked(renderMarked(blocks));
  assert.equal(parsed.get(3), '# Titolo');
  assert.equal(parsed.get(4), 'Corpo del\ntesto su due righe.');
});

test('un blocco mancante nella risposta è rilevabile', () => {
  const parsed = parseMarked('<<<0>>>\nTradotto.\n\n<<<2>>>\nAltro.');
  assert.deepEqual([...parsed.keys()], [0, 2]);
  assert.equal(parsed.has(1), false);
});

test('i percorsi delle figure vengono ripristinati se il modello li altera', () => {
  const original = '![Figura 1](figure/fig-1.png)\n\n![Figura 2](figure/fig-2.png)';
  const translated = '![Figure 1](figure/figure-1.png)\n\n![Figure 2](figure/fig-2.png)';
  const restored = restoreFigurePaths(original, translated);
  assert.ok(restored.includes('![Figure 1](figure/fig-1.png)'));
  assert.ok(restored.includes('![Figure 2](figure/fig-2.png)'));
});

test('scarta le singole frasi di contesto riecheggiate ai bordi della traduzione', () => {
  const previous = 'Questa frase appartiene soltanto al contesto precedente. Un secondo antecedente chiarisce il termine.';
  const next = 'Questa frase appartiene soltanto al contesto seguente.';
  const candidate = [
    'Un secondo antecedente chiarisce il termine.',
    'La famiglia è una rete di lealtà intergenerazionali.',
    next,
  ].join('\n');
  assert.equal(
    sanitizeTranslationCandidate({
      current: 'The family is a network of intergenerational loyalties.',
      candidate,
      previous,
      next,
    }),
    'La famiglia è una rete di lealtà intergenerazionali.',
  );
});

test('rifiuta un loop degenerativo della stessa frase restituita dal modello', () => {
  const repeated = 'La stessa frase molto lunga viene ripetuta dal modello senza alcuna ragione editoriale.';
  assert.equal(sanitizeTranslationCandidate({
    current: 'A longer source paragraph that should not be duplicated.',
    candidate: `${repeated} ${repeated} ${repeated}`,
  }), '');
});

test('rifiuta due traduzioni adiacenti identiche se i sorgenti erano diversi', () => {
  const translated = 'La famiglia estesa organizza una rete complessa di obblighi e lealtà che attraversano più generazioni.';
  assert.equal(isUnexpectedAdjacentTranslation({
    source: 'The second source paragraph has different content and should receive its own translation.',
    previousSource: 'The first source paragraph describes a multigenerational family network.',
    candidate: translated,
    previousTranslation: translated,
  }), true);
  assert.equal(isUnexpectedAdjacentTranslation({
    source: 'Intentional repeated source paragraph with enough words to be meaningful.',
    previousSource: 'Intentional repeated source paragraph with enough words to be meaningful.',
    candidate: translated,
    previousTranslation: translated,
  }), false);
});

test('rileva delimitatori Markdown persi o riaperti dai backslash', () => {
  assert.equal(preservesMarkdownDelimiters('_termine_', '_termine'), false);
  assert.equal(
    preservesMarkdownDelimiters(String.raw`Nota \*testo`, String.raw`Nota \\*testo`),
    false,
  );
  assert.equal(preservesMarkdownDelimiters('_termine_', '_termine tradotto_'), true);
});

test('rileva tag e destinazioni alterati durante la traduzione', () => {
  assert.equal(
    preservesMarkdownStructure('<footnote>Nota.</footnote>', '<footnote>Nota tradotta.'),
    false,
  );
  assert.equal(
    preservesMarkdownStructure('[fonte](https://example.test/a)', '[source](https://example.test/b)'),
    false,
  );
  assert.equal(
    preservesMarkdownStructure('<footnote>Nota.</footnote>', '<footnote>Nota tradotta.</footnote>'),
    true,
  );
});

test('senza testo il piano è vuoto', () => {
  assert.deepEqual(planTranslation('   \n\n  '), []);
});
