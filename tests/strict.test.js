import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildStrictDocument,
  buildDifferenceContexts,
  compareTokenInventory,
  compareTokenSequences,
  inlineMarkdownToTypst,
  missingInvariants,
  repairBoundaryOverlaps,
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

test('le omissioni sono affiancate alla frase PDF più simile', () => {
  const issues = buildDifferenceContexts(
    'Prima frase completa. Il convegno si tenne a Bologna nel febbraio 1985.',
    'Prima frase completa. Il convegno si tenne nel febbraio.',
    ['a', 'bologna', '1985'],
  );
  assert.equal(issues.length, 1);
  assert.deepEqual(issues[0].missing, ['a', 'bologna', '1985']);
  assert.match(issues[0].source, /Bologna/);
  assert.match(issues[0].rendered, /convegno/);
  assert.ok(issues[0].similarity > 0.5);
});

test('ripara una parola sovrapposta e riunisce il paragrafo', () => {
  const source = 'Noi discutevamo fra di noi cercando.\n\ncercando il punto nodale, potevamo intervenire.';
  const repaired = repairBoundaryOverlaps(source);
  assert.equal(repaired.text, 'Noi discutevamo fra di noi cercando il punto nodale, potevamo intervenire.');
  assert.equal(repaired.changes.length, 1);
  assert.equal(repaired.changes[0].overlap, 'cercando');
});

test('conserva i marcatori pagina dentro una frase riunita', () => {
  const source = 'Stavamo cercando il punto.\n\n<!-- pagina 2 -->\ncercando il punto nodale corretto.';
  const repaired = repairBoundaryOverlaps(source);
  assert.match(repaired.text, /Stavamo\n<!-- pagina 2 -->\ncercando il punto nodale/);
  const body = buildStrictDocument(repaired.text).body;
  assert.match(body, /Stavamo\n\/\/ pagina 2\ncercando il punto nodale/);
  assert.doesNotMatch(body, /<!--/);
});

test('ripara un suffisso ripetuto al cambio pagina', () => {
  const source = 'Discutevamo fra di noi cercando.\n\n<!-- pagina 19 -->\ncando il punto nodale.';
  const repaired = repairBoundaryOverlaps(source);
  assert.match(repaired.text, /noi cercando\n<!-- pagina 19 -->\nil punto nodale/);
  assert.equal(repaired.changes[0].type, 'boundary_word_split');
  assert.doesNotMatch(repaired.text, /cercando\.\s+.*cando/u);
});

test('ricompone due frammenti di parola validati dal dizionario', () => {
  const source = 'Discutevamo fra di noi cer\n\n<!-- pagina 19 -->\ncando il punto nodale.';
  const known = (word) => word.toLowerCase() === 'cercando';
  const repaired = repairBoundaryOverlaps(source, 10, known);
  assert.match(repaired.text, /noi\n<!-- pagina 19 -->\ncercando il punto nodale/);
  assert.equal(repaired.changes[0].after, 'cercando');
});

test('scarta il numero pagina e ricompone la parola che lo circonda', () => {
  const source = [
    '<!-- pagina 1 -->\nSiete stati convinti di ciò, che inconsciamente per-',
    '19',
    '<!-- pagina 2 -->\ndevate tutte le schede che venivano fatte.',
  ].join('\n\n');
  const known = (word) => word.toLowerCase() === 'perdevate';
  const repaired = repairBoundaryOverlaps(source, 10, known);
  assert.doesNotMatch(repaired.text, /\b19\b/);
  assert.match(repaired.text, /inconsciamente\n<!-- pagina 2 -->\nperdevate tutte le schede/);
  assert.ok(repaired.changes.some((change) => change.type === 'page_number_furniture'));
  assert.ok(repaired.changes.some((change) => change.type === 'boundary_word_split'));
});

test('scarta un numero pagina incollato alla continuazione', () => {
  const source = 'La frase continua per-\n\n<!-- pagina 2 -->\n19 devate tutte le schede.';
  const known = (word) => word.toLowerCase() === 'perdevate';
  const repaired = repairBoundaryOverlaps(source, 10, known);
  assert.doesNotMatch(repaired.text, /\b19\b/);
  assert.match(repaired.text, /<!-- pagina 2 -->\nperdevate tutte/);
});

test('scarta testatina e numero in alto prima di ricomporre la parola', () => {
  const source = [
    '<!-- pagina 1 -->\nQuesto esempio illustra il fatto che, cercando di definire con mag-',
    '<!-- pagina 2 -->\nIpotizzazione Circolarità Neutralità 11',
    'giore precisione il disordine, torniamo alla definizione.',
  ].join('\n\n');
  const known = (word) => word.toLowerCase() === 'maggiore';
  const repaired = repairBoundaryOverlaps(source, 10, known);
  assert.doesNotMatch(repaired.text, /Ipotizzazione|\b11\b/);
  assert.match(repaired.text, /con\n<!-- pagina 2 -->\nmaggiore precisione/);
  assert.ok(repaired.changes.some((change) => change.type === 'running_header_furniture'));
  assert.ok(repaired.changes.some((change) => change.type === 'boundary_word_split'));
});

test('scarta testatina e numero su righe iniziali dello stesso blocco pagina', () => {
  const source = 'Una frase aperta,\n\n<!-- pagina 2 -->\nIpotizzazione Circolarità Neutralità\n11\ncontinua qui.';
  const repaired = repairBoundaryOverlaps(source);
  assert.doesNotMatch(repaired.text, /Ipotizzazione|\b11\b/);
  assert.match(repaired.text, /<!-- pagina 2 -->\ncontinua qui/);
});

test('riunisce un paragrafo che continua nella pagina successiva', () => {
  const source = 'Il sistema era organizzato intorno a punti importanti,\n\n<!-- pagina 19 -->\nche erano nodali per tutti.';
  const repaired = repairBoundaryOverlaps(source);
  assert.match(repaired.text, /importanti,\n<!-- pagina 19 -->\nche erano nodali/);
  assert.equal(repaired.changes[0].type, 'boundary_paragraph_continuation');
  const body = buildStrictDocument(repaired.text).body;
  assert.match(body, /importanti,\n\/\/ pagina 19\nche erano nodali/);
});

test('non elimina ripetizioni intenzionali tra paragrafi autonomi', () => {
  const source = 'La conclusione è Fine.\n\nFine della storia e nuovo capitolo.';
  const repaired = repairBoundaryOverlaps(source);
  assert.equal(repaired.text, source);
  assert.equal(repaired.changes.length, 0);
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

test('il piano editoriale può correggere solo il livello dei titoli esistenti', () => {
  const source = '# Opera\n\n# Capitolo\n\n# Sezione\n\nTesto invariato.';
  const doc = buildStrictDocument(source, {
    headings: [
      { id: 'b-1', level: 1 },
      { id: 'b-2', level: 2 },
      { id: 'b-3', level: 3 },
    ],
  });
  assert.match(doc.body, /^= Opera$/m);
  assert.match(doc.body, /^== Capitolo$/m);
  assert.match(doc.body, /^=== Sezione$/m);
  assert.match(doc.body, /Testo invariato\./);
});
