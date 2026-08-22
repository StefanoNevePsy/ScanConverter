import test from 'node:test';
import assert from 'node:assert/strict';
import {
  auditDocumentDuplicates,
  auditDocumentLanguage,
  auditTypstDuplicates,
  auditTypstLanguage,
  detectPassageLanguage,
  documentLanguagePassages,
  findAdjacentDuplicatePassages,
  inferDocumentLanguage,
  isTranslationLanguageSafe,
  parsePageSelection,
  reconcileDuplicateAuditWithWorkingText,
} from '../src/lib/languageAudit.js';

test('segnala prosa inglese in un documento italiano', () => {
  const detected = detectPassageLanguage(
    'The family is a system in which the parents and the children are connected by loyalty and obligation.',
    'it',
    'en',
  );
  assert.equal(detected.suspicious, true);
  assert.equal(detected.detectedLang, 'en');
});

test('non scambia un paragrafo italiano con termini tecnici per inglese', () => {
  const detected = detectPassageLanguage(
    'La lealtà familiare è un concetto relazionale che descrive gli obblighi tra i genitori e i figli nel corso delle generazioni.',
    'it',
    'en',
  );
  assert.equal(detected.suspicious, false);
});

test('rileva titoli e frasi brevi rimasti in inglese', () => {
  const source = [
    '#set text(lang: "it")',
    '// pagina 7',
    '= Invisible loyalties',
    '',
    'This is not the answer.',
    '',
    '== Family obligations',
    '',
    '= Lealtà invisibili',
  ].join('\n\n');
  const audit = auditTypstLanguage(source, 'it', 'en');
  assert.equal(audit.items.length, 3);
  assert.deepEqual(audit.items.map((item) => item.sample), [
    'Invisible loyalties',
    'This is not the answer.',
    'Family obligations',
  ]);
  assert.ok(audit.items.every((item) => source.slice(item.start, item.end) === item.text));
});

test('non segnala un titolo italiano con un termine tecnico inglese isolato', () => {
  const source = '// pagina 8\n\n= Il concetto di feedback nella terapia';
  assert.equal(auditTypstLanguage(source, 'it', 'en').items.length, 0);
});

test('raggruppa le testatine brevi identiche conservando tutte le occorrenze Typst', () => {
  const source = [2, 3, 4]
    .map((page) => `// pagina ${page}\n\n= Invisible loyalties`)
    .join('\n\n');
  const audit = auditTypstLanguage(source, 'it', 'en');
  assert.equal(audit.items.length, 1);
  assert.equal(audit.items[0].occurrenceCount, 3);
  assert.equal(audit.items[0].passageIds.length, 3);
  assert.deepEqual(audit.items[0].occurrencePages, [2, 3, 4]);
});

test('riconosce la lingua dominante dei vecchi progetti senza metadati', () => {
  const source = Array.from(
    { length: 8 },
    () => 'La famiglia è un sistema in cui i genitori e i figli sono legati tra loro e con le altre generazioni.',
  ).join('\n\n') + '\n\nThe family and the system are connected by loyalty.';
  assert.equal(inferDocumentLanguage(source, 'en'), 'it');
});

test('la guardia rifiuta una traduzione in spagnolo invece che in italiano', () => {
  const original = 'The family is a system in which the parents and the children are connected by loyalty and obligation.';
  const wrong = 'La familia es un sistema en el que los padres y los hijos están conectados por la lealtad y sus obligaciones.';
  const correct = 'La famiglia è un sistema nel quale i genitori e i figli sono legati dalla lealtà e dai loro obblighi.';
  assert.equal(isTranslationLanguageSafe(original, wrong, 'it', 'en'), false);
  assert.equal(isTranslationLanguageSafe(original, correct, 'it', 'en'), true);
});

test('conserva pagina e offset esatti dei passaggi', () => {
  const source = '<!-- pagina 10 -->\n\nPrimo paragrafo.\n\nSecondo paragrafo.\n\n<!-- pagina 11 -->\n\nTerzo.';
  const passages = documentLanguagePassages(source);
  assert.deepEqual(passages.map((item) => item.page), [10, 10, 11]);
  for (const item of passages) assert.equal(source.slice(item.start, item.end), item.text);
});

test('le bibliografie sospette sono mostrate ma non preselezionate', () => {
  const source = '<!-- pagina 20 -->\n\n## References\n\n1. Author A: The family and the system. New York, 1964.\n2. Author B: The parents and their children. London, 1972.\n3. Author C: The theory of loyalty. Boston, 1980.';
  const audit = auditDocumentLanguage(source, 'it', 'en');
  assert.ok(audit.items.length >= 1);
  assert.ok(audit.items.every((item) => item.recommended === false));
});

test('interpreta pagine singole e intervalli senza duplicati', () => {
  assert.deepEqual(parsePageSelection('251, 285-286; 306 285'), [251, 285, 286, 306]);
  assert.throws(() => parsePageSelection('10-x'), /non valido/);
});

test('trova solo paragrafi adiacenti realmente duplicati', () => {
  const repeated = 'La famiglia è un sistema relazionale nel quale obblighi e lealtà attraversano più generazioni.';
  const source = `<!-- pagina 12 -->\n\n${repeated}\n\n${repeated.toUpperCase()}\n\nPassaggio diverso e autonomo.`;
  const duplicates = findAdjacentDuplicatePassages(source);
  assert.equal(duplicates.length, 1);
  assert.match(duplicates[0].text, /FAMIGLIA/);
});

test('non elimina ripetizioni brevi o separate da una pagina', () => {
  const short = 'Nota ripetuta intenzionalmente.';
  const source = `<!-- pagina 1 -->\n\n${short}\n\n${short}\n\n<!-- pagina 2 -->\n\n${short}`;
  assert.deepEqual(findAdjacentDuplicatePassages(source), []);
});

test('rileva localmente paragrafi, frasi e frammenti consecutivi duplicati', () => {
  const paragraph = 'La famiglia è un sistema relazionale nel quale obblighi e lealtà attraversano più generazioni.';
  const sentence = 'Questa frase abbastanza lunga descrive con precisione il legame tra genitori e figli.';
  const fragment = 'gli obblighi invisibili attraversano le generazioni e influenzano tutte le relazioni familiari';
  const source = [
    '<!-- pagina 12 -->',
    paragraph,
    paragraph,
    `Prima osservazione. ${sentence} ${sentence} Chiusura del ragionamento.`,
    `Nel testo ${fragment}, ${fragment} senza che i membri ne siano consapevoli.`,
  ].join('\n\n');
  const audit = auditDocumentDuplicates(source);
  assert.deepEqual(audit.counts, { paragraphs: 1, sentences: 1, fragments: 1 });
  assert.deepEqual(audit.items.map((item) => item.type), ['paragraph', 'sentence', 'fragment']);
  for (const item of audit.items) assert.ok(source.slice(item.start, item.end).length > 0);
});

test('ignora ripetizioni brevi, non consecutive e riferimenti bibliografici', () => {
  const source = [
    '<!-- pagina 4 -->',
    'Molto bene. Molto bene.',
    'Una frase abbastanza lunga compare qui ma non deve essere considerata duplicata in modo automatico.',
    'Un passaggio diverso separa intenzionalmente le due occorrenze nel testo.',
    'Una frase abbastanza lunga compare qui ma non deve essere considerata duplicata in modo automatico.',
    '## Bibliografia',
    'Bowlby J. Attachment and loss. London, 1969. Bowlby J. Attachment and loss. London, 1969.',
  ].join('\n\n');
  assert.deepEqual(auditDocumentDuplicates(source).items, []);
});

test('nasconde un duplicato canonico già rimosso manualmente dal Typst', () => {
  const paragraph = 'La famiglia è un sistema relazionale nel quale obblighi e lealtà attraversano più generazioni.';
  const canonical = `<!-- pagina 12 -->\n\n${paragraph}\n\n${paragraph}`;
  const audit = auditDocumentDuplicates(canonical);
  assert.equal(audit.items.length, 1);
  const workingTypst = `#set page(width: 210mm)\n\n// pagina 12\n\n${paragraph}`;
  const reconciled = reconcileDuplicateAuditWithWorkingText(audit, workingTypst);
  assert.equal(reconciled.items.length, 0);
  assert.equal(reconciled.hiddenFromWorkingText, 1);
});

test('trova e rimuove dalla lista i duplicati usando direttamente gli offset Typst', () => {
  const paragraph = 'La famiglia è un sistema relazionale nel quale obblighi e lealtà attraversano più generazioni.';
  const source = `#set text(lang: "it")\n\n// pagina 12\n\n${paragraph}\n\n${paragraph}`;
  const audit = auditTypstDuplicates(source);
  assert.equal(audit.items.length, 1);
  const duplicate = audit.items[0];
  assert.equal(source.slice(duplicate.start, duplicate.end), duplicate.text);
  assert.equal(duplicate.sourceFormat, 'typst');
});
