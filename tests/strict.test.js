import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildStrictDocument,
  buildDifferenceContexts,
  compareTokenInventory,
  compareTokenSequences,
  inlineMarkdownToTypst,
  missingInvariants,
  rebaseCanonicalRevision,
  rebaseMissingCanonicalPassage,
  rebaseStrictPassage,
  rebaseStrictPassageFuzzy,
  repairBoundaryOverlaps,
  replaceContextualText,
  replaceUniqueText,
  restoreCanonicalPassage,
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

test('la revisione sostituisce solo occorrenze canoniche univoche', () => {
  assert.equal(replaceUniqueText('prima errata dopo', 'errata', 'corretta'), 'prima corretta dopo');
  assert.equal(replaceUniqueText('errata e errata', 'errata', 'corretta'), null);
});

test('la revisione canonica preserva modifiche Typst lontane dal passaggio', () => {
  const before = 'Primo paragrafo errata.\n\nSecondo paragrafo.';
  const after = 'Primo paragrafo corretto.\n\nSecondo paragrafo.';
  const editor = buildStrictDocument(before).body.replace('Secondo', '*Secondo*');
  const revised = rebaseCanonicalRevision(editor, before, after);
  assert.match(revised, /paragrafo corretto/);
  assert.match(revised, /\*Secondo\*/);
});

test('il ripristino OCR usa il contesto quando la forma corretta ricorre più volte', () => {
  const raw = [
    'La terapia sistemica apre il capitolo introduttivo con un esempio generale.',
    'Nel caso clinico la terapla familiare viene discussa insieme alle lealtà invisibili.',
    'La terapia individuale compare infine nelle conclusioni del volume.',
  ].join('\n\n');
  const canonical = raw.replace('terapla', 'terapia');
  const restored = replaceContextualText(canonical, 'terapia', 'terapla', {
    referenceSource: raw,
    referenceFind: 'terapla',
  });
  assert.ok(restored);
  assert.match(restored, /caso clinico la terapla familiare/);
  assert.match(restored, /La terapia sistemica/);
  assert.match(restored, /La terapia individuale/);
});

test('il ripristino OCR resta chiuso senza una posizione di riferimento', () => {
  const raw = 'Il testo OCR non contiene più la forma registrata.';
  const canonical = 'La terapia compare qui e la terapia compare anche altrove.';
  assert.equal(replaceContextualText(canonical, 'terapia', 'terapla', {
    referenceSource: raw,
    referenceFind: 'terapla',
  }), null);
});

test('una correzione ortografica aggregata ripristina tutte le occorrenze previste', () => {
  assert.equal(
    replaceContextualText('refuso e refuso', 'refuso', 'refuzo', { replaceCount: 2 }),
    'refuzo e refuzo',
  );
});

test('la ritraduzione locale cambia un solo passaggio e conserva il Typst circostante', () => {
  const editor = [
    '#set text(size: 11pt)',
    '#block(stroke: 1pt)[The family is a system.]',
    '*Modifica manuale lontana*',
  ].join('\n\n');
  const rebased = rebaseStrictPassage(
    editor,
    'The family is a system.',
    'La famiglia è un sistema.',
  );
  assert.match(rebased, /La famiglia è un sistema/);
  assert.match(rebased, /\*Modifica manuale lontana\*/);
  assert.match(rebased, /#block\(stroke: 1pt\)/);
});

test('la revisione canonica usa il contesto quando il passaggio è duplicato e già ritoccato', () => {
  const repeated = 'La famiglia è un sistema nel quale le relazioni attraversano tutte le generazioni. '.repeat(6);
  const before = `Introduzione univoca al primo caso.\n\n${repeated}\n\nIntermezzo univoco tra i due casi.\n\n${repeated}\n\nConclusione univoca del secondo caso.`;
  const secondStart = before.lastIndexOf(repeated);
  const translated = 'Il secondo passaggio è stato ritradotto correttamente e conserva il proprio contesto.';
  const after = before.slice(0, secondStart) + translated + before.slice(secondStart + repeated.length);
  const generated = buildStrictDocument(before).body;
  const targetStart = generated.lastIndexOf('La famiglia è un sistema');
  const editor = generated.slice(0, targetStart) +
    generated.slice(targetStart).replace('sistema', 'sistema relazionale');
  const rebased = rebaseCanonicalRevision(editor, before, after);
  assert.ok(rebased);
  assert.match(rebased, /Il secondo passaggio è stato ritradotto/);
  assert.equal((rebased.match(/La famiglia è un sistema/g) || []).length, 6);
});

test('la ritraduzione fuzzy usa estremi univoci quando il centro è già stato corretto', () => {
  const before = 'Questo lungo passaggio originale contiene molte parole stabili all’inizio e descrive un sistema familiare complesso nel quale il centro è stato modificato manualmente ma le ultime parole restano perfettamente riconoscibili.';
  const editor = `Contesto precedente.\n\n${before.replace('il centro è stato modificato', '*la parte centrale è stata corretta*')}\n\nContesto successivo.`;
  const after = 'Questo lungo passaggio è stato tradotto in modo completo e verificabile.';
  const rebased = rebaseStrictPassageFuzzy(editor, before, after);
  assert.ok(rebased);
  assert.match(rebased, /tradotto in modo completo/);
  assert.match(rebased, /Contesto precedente/);
  assert.match(rebased, /Contesto successivo/);
});

test('la ritraduzione fuzzy rifiuta estremi duplicati', () => {
  const before = 'Questa sequenza iniziale ha abbastanza parole per risultare stabile e termina con una coda altrettanto lunga e chiaramente riconoscibile.';
  const editor = `${before}\n\n${before}`;
  assert.equal(rebaseStrictPassageFuzzy(editor, before, 'Proposta nuova.'), null);
});

test('reinserisce un passaggio canonico omesso soltanto fra due ancore univoche', () => {
  const intro = 'Introduzione stabile e univoca che precede il passaggio mancante nel documento corrente.';
  const missing = 'Questo passaggio molto lungo appartiene alla fonte canonica ma è stato omesso per errore durante una precedente trasformazione del testo.';
  const following = 'Il paragrafo immediatamente successivo è stato corretto manualmente e quindi non coincide più alla lettera.';
  const tail = 'Una coda abbastanza distante offre invece una seconda ancora stabile e sicuramente univoca nel documento. Questa coda prosegue con altre parole precise affinché possa essere localizzata senza dipendere dal paragrafo modificato.';
  const before = `${intro}\n\n${missing}\n\n${following}\n\n${tail}`;
  const translated = 'Passaggio reinserito e tradotto correttamente nel punto canonico.';
  const after = `${intro}\n\n${translated}\n\n${following}\n\n${tail}`;
  const editor = buildStrictDocument(`${intro}\n\n${following}\n\n${tail}`).body
    .replace('corretto manualmente', '*già corretto*');
  const rebased = rebaseMissingCanonicalPassage(editor, before, after, {}, missing, translated);
  assert.ok(rebased);
  assert.match(rebased, /Passaggio reinserito/);
  assert.match(rebased, /\*già corretto\*/);
  assert.match(rebased, /seconda ancora stabile/);
});

test('ripristina dalla fonte canonica soltanto il blocco Typst discordante', () => {
  const canonical = 'Primo passaggio completo e corretto.\n\nSecondo passaggio invariato.';
  const editor = buildStrictDocument(canonical).body
    .replace('completo e corretto', 'tronco')
    .replace('Secondo', '*Secondo*');
  const restored = restoreCanonicalPassage(editor, canonical, 'Primo passaggio completo e corretto.');
  assert.match(restored, /Primo passaggio completo e corretto/);
  assert.match(restored, /\*Secondo\*/);
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

test('la frase riunita resta su una riga e il marcatore pagina la segue', () => {
  const source = 'Stavamo cercando il punto.\n\n<!-- pagina 2 -->\ncercando il punto nodale corretto.';
  const repaired = repairBoundaryOverlaps(source);
  assert.match(repaired.text, /Stavamo\n<!-- pagina 2 -->\ncercando il punto nodale/);
  const body = buildStrictDocument(repaired.text).body;
  // Il capoverso non va spezzato a metà frase: nell'editor si legge di
  // seguito, e il segno di pagina esce dopo, come blocco a sé.
  assert.match(body, /Stavamo cercando il punto nodale corretto\./);
  assert.match(body, /\n\n\/\/ pagina 2/);
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

test('ricompone le parole sillabate a fine riga nella stessa pagina', () => {
  const source = 'Consideriamo produttivi alcuni principi, indi-\ncandoli finché non troviamo termini migliori.';
  const repaired = repairBoundaryOverlaps(
    source,
    10,
    (word) => word.toLowerCase() === 'indicandoli',
  );
  assert.equal(
    repaired.text,
    'Consideriamo produttivi alcuni principi, indicandoli finché non troviamo termini migliori.',
  );
  assert.equal(repaired.changes[0].type, 'line_word_split');
});

test('ricompone le sillabazioni OCR appiattite con spazi attorno al trattino', () => {
  const source =
    'Formulò un’ipo - tesi in qual - che modo. Con - formemente decise di ' +
    'dedicare ascol - to e dedi - zione, poi iniziò a scom - porsi.';
  const known = new Set([
    'ipotesi', 'qualche', 'conformemente', 'ascolto', 'dedizione', 'scomporsi',
  ]);
  const repaired = repairBoundaryOverlaps(source, 10, (word) => known.has(word.toLowerCase()));
  assert.equal(
    repaired.text,
    'Formulò un’ipotesi in qualche modo. Conformemente decise di dedicare ' +
      'ascolto e dedizione, poi iniziò a scomporsi.',
  );
  assert.equal(repaired.changes.length, 6);
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
  assert.match(body, /importanti, che erano nodali per tutti\./);
  assert.match(body, /\n\n\/\/ pagina 19/);
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

test('il renderer trasforma le note semantiche in vere footnote Typst', () => {
  const source = 'Testo principale. <footnote>Nota con _titolo_ e volume 1.</footnote>\n\nTesto seguente.';
  const doc = buildStrictDocument(source);
  assert.match(doc.body, /Testo principale\. #footnote\[Nota con _titolo_ e volume 1\.\]/);
  assert.doesNotMatch(doc.body, /<footnote>/);
  assert.match(
    sourcePlainText(source).replace(/\s+/g, ' '),
    /Testo principale\. Nota con titolo e volume 1\./,
  );
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

test('converte le cifre in apice in richiami Typst reali', () => {
  assert.equal(inlineMarkdownToTypst('Citazione¹ e volume².'), 'Citazione#super[1] e volume#super[2].');
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

test('il segno di pagina non spezza mai un capoverso', () => {
  const source = [
    'Il terapeuta osserva la scena',
    '<!-- pagina 7 -->',
    'e non interviene fino alla fine.',
  ].join('\n');
  const body = buildStrictDocument(source).body;
  const lines = body.split('\n').filter((line) => line.trim());
  // Il capoverso è una riga sola, il marcatore un'altra: nessuna riga mista.
  assert.deepEqual(lines, [
    'Il terapeuta osserva la scena e non interviene fino alla fine.',
    '// pagina 7',
  ]);
});

test('senza parole mancanti il confronto per frase non fa nulla', () => {
  // Un documento pulito pagava comunque il confronto di ogni frase con ogni
  // frase: su un libro erano minuti per non dire niente.
  const testo = Array.from({ length: 400 }, (_, i) => `Frase numero ${i} del documento.`).join(' ');
  assert.deepEqual(buildDifferenceContexts(testo, testo, []), []);
});

test('mostra la frase giusta anche in un documento lungo', () => {
  // Frasi con contenuto DIVERSO, come in un libro vero: se fossero tutte
  // uguali il vicino somiglierebbe più dell'originale e la prova non
  // direbbe niente.
  const soggetti = ['terapeuta', 'madre', 'padre', 'figlia', 'nonna', 'fratello', 'analista', 'gruppo'];
  const azioni = ['osserva', 'interrompe', 'ricorda', 'nomina', 'contesta', 'accoglie', 'misura', 'rimanda'];
  const oggetti = ['la lealtà', 'il debito', 'la colpa', 'il merito', 'la delega', 'il conto', 'la promessa'];
  const frasi = Array.from({ length: 900 }, (_, i) =>
    `${soggetti[i % 8]} ${azioni[(i * 3) % 8]} ${oggetti[(i * 5) % 7]} nella seduta ${i}.`);
  const fonte = frasi.join(' ');
  const bersaglio = frasi[600];
  // La perdita è a due terzi del documento, lontano dall'inizio.
  const rovinato = fonte.replace(bersaglio, bersaglio.replace(' nella seduta 600.', '.'));
  const mancanti = compareTokenInventory(fonte, rovinato).missing;
  const issues = buildDifferenceContexts(fonte, rovinato, mancanti);
  assert.equal(issues.length >= 1, true);
  const primo = issues.find((issue) => /seduta 600/.test(issue.source));
  assert.ok(primo, 'la frase incompleta deve comparire fra le differenze');
  // Il passaggio accostato è quello corrispondente, non uno a caso.
  assert.equal(primo.similarity > 0.7, true);
  assert.equal(primo.missing.includes('600'), true);
});

test('trova il corrispondente anche se il documento è stato riordinato', () => {
  // La ricerca guarda prima l'intorno; quando lì non somiglia niente si
  // allarga a tutto il documento, che è il caso raro ma deve funzionare.
  const frasi = Array.from({ length: 400 }, (_, i) => `Paragrafo ${i} con parole comuni e ordinarie.`);
  const fonte = ['La zebrone marcia solitaria verso il tramonto viola.', ...frasi].join(' ');
  const rovinato = [...frasi, 'La zebrone marcia solitaria verso il tramonto.'].join(' ');
  const mancanti = compareTokenInventory(fonte, rovinato).missing;
  const issues = buildDifferenceContexts(fonte, rovinato, mancanti);
  const zebrone = issues.find((i) => /zebrone/.test(i.source));
  assert.ok(zebrone, 'la frase spostata deve comparire fra le differenze');
  assert.match(zebrone.rendered, /zebrone/);
});
