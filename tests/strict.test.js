import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildStrictDocument,
  compareTokenInventory,
  compareTokenSequences,
  inlineMarkdownToTypst,
  missingInvariants,
  sourcePlainText,
} from '../src/lib/strict.js';

test('il confronto rileva omissioni, aggiunte e duplicati', () => {
  const missing = compareTokenSequences('uno due tre due', 'uno tre due');
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missing, ['due']);

  const added = compareTokenSequences('uno due', 'uno nuovo due');
  assert.equal(added.ok, false);
  assert.deepEqual(added.added, ['nuovo']);
});

test('accenti e punteggiatura non producono falsi positivi', () => {
  assert.equal(compareTokenSequences('Perché è così.', 'Perche e cosi').ok, true);
});

test('sillabazione PDF e ordine tabellare non simulano omissioni', () => {
  assert.equal(compareTokenInventory('testo necessario completo', 'testo neces- sario completo').ok, true);
  const reordered = compareTokenInventory('nome valore alfa 42', 'nome alfa valore 42');
  assert.equal(reordered.ok, true);
  assert.equal(compareTokenSequences('nome valore alfa 42', 'nome alfa valore 42').ok, false);
});

test('numeri, percentuali e DOI restano invarianti', () => {
  const missing = missingInvariants(
    'Dose 12,5% nel 2024, DOI 10.1000/XYZ-1',
    'Dose 12,5% nel 2025, DOI 10.1000/XYZ-1',
  );
  assert.ok(missing.includes('2024'));
});

test('il renderer conserva testo, gerarchia, liste e didascalie', () => {
  const source = [
    '# Titolo',
    'Testo _corsivo_ con 15%.',
    '- Primo punto\n- Secondo punto',
    '![Figura originale](/figures/fig-1.png)',
  ].join('\n\n');
  const doc = buildStrictDocument(source);
  assert.match(doc.body, /^= Titolo/m);
  assert.match(doc.body, /_corsivo_/);
  assert.match(doc.body, /- Primo punto/);
  assert.match(doc.body, /Figura originale/);
  assert.doesNotMatch(doc.body, /#figure/); // niente numerazione automatica aggiunta
  assert.match(sourcePlainText(source), /Figura originale/);
});

test('i marcatori pagina non diventano testo visibile', () => {
  const doc = buildStrictDocument('<!-- pagina 1 -->\nPrimo paragrafo.\n\n<!-- pagina 2 -->\nSecondo paragrafo.');
  assert.match(doc.body, /\/\/ pagina 1/);
  assert.match(doc.body, /\/\/ pagina 2/);
  assert.doesNotMatch(doc.body, /<!--/);
});

test('le tabelle LaTeX diventano tabelle Typst senza comandi visibili', () => {
  const source = String.raw`\begin{tabular}{lc}
\textbf{Nome} & \textbf{Valore} \\
Alfa & 42 \\
\end{tabular}`;
  const doc = buildStrictDocument(source);
  assert.match(doc.body, /#table\(columns: 2/);
  assert.doesNotMatch(doc.body, /begin\\\{tabular/);
  assert.deepEqual(sourcePlainText(source).match(/[\p{L}\p{N}]+/gu), ['Nome', 'Valore', 'Alfa', '42']);
});

test('il testo OCR non può eseguire codice Typst', () => {
  const rendered = inlineMarkdownToTypst('testo #set page() e $formula$');
  assert.match(rendered, /\\#set/);
  assert.match(rendered, /\\\$formula\\\$/);
});

test('il piano editoriale cambia solo lo stile e conserva i blocchi', () => {
  const source = '# Titolo\n\nUna citazione importante.\n\nParagrafo finale.';
  const doc = buildStrictDocument(source, {
    document: { font: 'ptserif', headfont: 'ptsans', margin: 'xwide', density: 'airy' },
    blocks: [{ id: 'b-2', style: 'quote' }],
  });
  assert.match(doc.preamble, /PT Serif/);
  assert.match(doc.preamble, /right: 6cm/);
  assert.match(doc.body, /stroke: \(left:/);
  for (const text of ['Titolo', 'Una citazione importante', 'Paragrafo finale']) {
    assert.match(doc.body, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});
