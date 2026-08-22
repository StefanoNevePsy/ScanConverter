/*
  Traduzione come FASE SEPARATA, a valle dell'OCR.

  Perché separata e non una trasformazione della pipeline: tutte le verifiche
  del progetto — inventario dei token, sottosequenza, guardia sulle tabelle —
  esistono per impedire che il testo cambi. Una traduzione cambia ogni parola:
  farla passare di lì significherebbe disattivare proprio le difese che
  rendono affidabile il resto. Quindi la traduzione produce un SECONDO
  documento, che poi percorre la stessa pipeline di strutturazione dell'altro.
  L'originale resta intatto e confrontabile.

  Due scelte governano la qualità, e sono entrambe sul TAGLIO del testo:

  1. Non si spezza mai una frase. Un modello che riceve «…e per questo motivo
     la famiglia» non ha modo di sapere come finisce, e completa a caso. I
     tagli cadono fra blocchi; se un blocco è troppo grande, fra frasi.

  2. Ogni pezzo porta con sé qualche frase PRIMA e qualche frase DOPO, come
     contesto dichiarato e non traducibile. Senza, all'inizio di ogni pezzo i
     pronomi non hanno antecedente («questo approccio» — quale?) e i termini
     già tradotti nel pezzo precedente vengono resi in un altro modo.

  La struttura si protegge con marcatori numerati: il modello riceve blocchi
  etichettati e deve restituire le stesse etichette. È una verifica meccanica,
  non una speranza: se un blocco manca, si ritraduce da solo.
*/

import { engineChat, contextBlock } from './engines.js';
import { phaseConfig } from './phases.js';
import { isTranslationLanguageSafe } from './languageAudit.js';

/** Lingue offerte nell'interfaccia. `auto` vale solo come lingua di partenza. */
export const LANGUAGES = [
  { code: 'auto', label: 'Rileva automaticamente' },
  { code: 'it', label: 'Italiano' },
  { code: 'en', label: 'Inglese' },
  { code: 'fr', label: 'Francese' },
  { code: 'de', label: 'Tedesco' },
  { code: 'es', label: 'Spagnolo' },
  { code: 'pt', label: 'Portoghese' },
  { code: 'la', label: 'Latino' },
  { code: 'el', label: 'Greco' },
];

export function languageLabel(code) {
  return LANGUAGES.find((l) => l.code === code)?.label || code;
}

// Abbreviazioni dopo le quali il punto NON chiude la frase. Senza questa
// lista «cfr. Bateson» e «p. 42» diventerebbero due frasi, e il taglio
// cadrebbe in mezzo a un riferimento bibliografico.
const ABBREVIATIONS = new Set([
  'cfr', 'ecc', 'es', 'p', 'pp', 'cap', 'capp', 'fig', 'figg', 'tab', 'vol',
  'ed', 'eds', 'trad', 'op', 'cit', 'ibid', 'vs', 'nn', 'art', 'sec', 'n',
  'dott', 'prof', 'sig', 'sigg', 'av', 'dc', 'ca', 'etc', 'et', 'al', 'i',
  'e', 'vd', 'v', 'st', 'mr', 'mrs', 'dr', 'jr', 'sr', 'inc', 'no', 'nos',
]);

/**
 * Divide un testo in frasi complete.
 *
 * Non usa `Intl.Segmenter` perché il taglio deve essere identico ovunque
 * l'app giri (browser, WebView Android, Electron) e verificabile dai test.
 *
 * @param {string} text
 * @returns {string[]} frasi, spazi di separazione inclusi in coda
 */
export function splitSentences(text) {
  const source = String(text || '');
  if (!source.trim()) return [];
  const out = [];
  let start = 0;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch !== '.' && ch !== '!' && ch !== '?' && ch !== '…') continue;
    // Punti di sospensione e «?!»: la frase finisce dopo l'ultimo segno.
    let end = i;
    while (end + 1 < source.length && '.!?…'.includes(source[end + 1])) end++;
    // Virgolette e parentesi di chiusura appartengono ancora alla frase.
    const closers = end;
    while (end + 1 < source.length && '»"”’\')]'.includes(source[end + 1])) end++;
    const next = source[end + 1];
    if (next !== undefined && !/\s/.test(next)) continue;
    // Discorso diretto: «“Non lo so…” rispose lui.» è UNA frase, e si riconosce
    // perché dopo la chiusura delle virgolette il testo riprende in minuscolo.
    if (end > closers && /^\s*\p{Ll}/u.test(source.slice(end + 1))) continue;

    if (ch === '.' && end === i) {
      const before = source.slice(Math.max(0, i - 12), i);
      const word = (before.match(/([\p{L}]+)$/u)?.[1] || '').toLowerCase();
      if (ABBREVIATIONS.has(word)) continue;
      // Iniziale puntata di un nome proprio: «C. G. Jung».
      if (word.length === 1 && /\p{Lu}/u.test(before.slice(-1))) continue;
      // Numerazione «3.2.1» o data «12.4.1998».
      if (/\d$/.test(before) && /^\s?\d/.test(source.slice(end + 1, end + 3))) continue;
    }

    let stop = end + 1;
    while (stop < source.length && /[^\S\n]/.test(source[stop])) stop++;
    out.push(source.slice(start, stop));
    start = stop;
  }
  if (start < source.length) out.push(source.slice(start));
  return out.filter((s) => s.trim());
}

/**
 * Divide il Markdown in blocchi logici, uno per unità di traduzione.
 *
 * Un blocco è un paragrafo, un titolo, una riga di tabella, una figura. Sono
 * le unità che il modello deve restituire una per una: tenerle separate è ciò
 * che rende verificabile la struttura del risultato.
 *
 * @param {string} markdown
 * @returns {{id:number, text:string, kind:string, translate:boolean}[]}
 */
export function splitBlocks(markdown) {
  const blocks = [];
  let id = 0;
  for (const raw of String(markdown || '').split(/\n{2,}/)) {
    const text = raw.replace(/\s+$/, '');
    if (!text.trim()) continue;
    blocks.push({ id: id++, text, kind: classify(text), translate: hasWords(text) });
  }
  return blocks;
}

function classify(text) {
  const first = text.trimStart();
  if (/^#{1,6}\s/.test(first)) return 'heading';
  if (/^!\[/.test(first)) return 'figure';
  if (/^\|/.test(first)) return 'table';
  if (/^([-*+]|\d+[.)])\s/.test(first)) return 'list';
  return 'prose';
}

/**
 * Un blocco fatto solo di segni (righelli, numeri di pagina) non si traduce.
 * Dalle immagini si toglie il PERCORSO, non la didascalia: `figure/f1.png`
 * non è testo, ma «Figura 1 — lo schema» sì ed è da tradurre.
 */
function hasWords(text) {
  return /\p{L}{2,}/u.test(text.replace(/\]\([^)]*\)/gu, ']'));
}

/**
 * Raggruppa i blocchi in richieste, con il contesto prima e dopo.
 *
 * Il contesto è testo che il modello legge ma NON traduce: serve solo a dargli
 * gli antecedenti dei pronomi e la resa già scelta per i termini ricorrenti.
 * Viene misurato in frasi, non in caratteri, perché una mezza frase come
 * contesto è peggio di nessun contesto.
 *
 * @param {string} markdown
 * @param {{maxChars?:number, overlap?:number}} [options]
 * @returns {{index:number, blocks:object[], before:string, after:string}[]}
 */
export function planTranslation(markdown, options = {}) {
  // Sotto una frase lunga il taglio non ha più senso: si passerebbe il tempo
  // a mandare contesto invece che testo.
  const maxChars = Math.max(200, options.maxChars ?? 2400);
  const overlap = Math.max(0, options.overlap ?? 2);
  const blocks = splitBlocks(markdown);
  if (!blocks.length) return [];

  // Un blocco più lungo del limite viene diviso fra le sue frasi, mai dentro.
  const units = [];
  for (const block of blocks) {
    if (block.text.length <= maxChars || block.kind !== 'prose') {
      units.push({ ...block, sourceId: block.id });
      continue;
    }
    const sentences = splitSentences(block.text);
    let buffer = '';
    for (const sentence of sentences) {
      if (buffer && buffer.length + sentence.length > maxChars) {
        units.push({ ...block, id: units.length, sourceId: block.id, text: buffer.trimEnd() });
        buffer = '';
      }
      buffer += sentence;
    }
    if (buffer.trim()) units.push({ ...block, id: units.length, sourceId: block.id, text: buffer.trimEnd() });
  }
  units.forEach((unit, i) => { unit.id = i; });

  const groups = [];
  let current = [];
  let size = 0;
  for (const unit of units) {
    if (current.length && size + unit.text.length > maxChars) {
      groups.push(current);
      current = [];
      size = 0;
    }
    current.push(unit);
    size += unit.text.length + 2;
  }
  if (current.length) groups.push(current);

  return groups.map((group, index) => ({
    index,
    blocks: group,
    before: tailSentences(units, group[0].id, overlap),
    after: headSentences(units, group[group.length - 1].id, overlap),
  }));
}

/** Ultime `count` frasi che precedono il blocco `id`. */
function tailSentences(units, id, count) {
  if (count <= 0) return '';
  const collected = [];
  for (let i = id - 1; i >= 0 && collected.length < count; i--) {
    const sentences = splitSentences(units[i].text);
    for (let j = sentences.length - 1; j >= 0 && collected.length < count; j--) {
      collected.unshift(sentences[j].trim());
    }
  }
  return collected.join(' ');
}

/** Prime `count` frasi che seguono il blocco `id`. */
function headSentences(units, id, count) {
  if (count <= 0) return '';
  const collected = [];
  for (let i = id + 1; i < units.length && collected.length < count; i++) {
    for (const sentence of splitSentences(units[i].text)) {
      if (collected.length >= count) break;
      collected.push(sentence.trim());
    }
  }
  return collected.join(' ');
}

const MARK = (id) => `<<<${id}>>>`;
const MARK_RE = /<<<(\d+)>>>/g;

/** Blocchi etichettati, nel formato che il modello deve restituire. */
export function renderMarked(blocks) {
  return blocks.map((b) => `${MARK(b.id)}\n${b.text}`).join('\n\n');
}

/**
 * Rilegge la risposta del modello e la riporta a blocchi indicizzati.
 * Un'etichetta assente non è un dettaglio: significa che quel blocco non è
 * stato tradotto, e il chiamante lo ritenta da solo.
 */
export function parseMarked(text) {
  const source = String(text || '');
  const out = new Map();
  const marks = [...source.matchAll(MARK_RE)];
  for (let i = 0; i < marks.length; i++) {
    const id = Number(marks[i][1]);
    const from = marks[i].index + marks[i][0].length;
    const to = i + 1 < marks.length ? marks[i + 1].index : source.length;
    const body = source.slice(from, to).replace(/^\s*\n/, '').trimEnd();
    if (body.trim()) out.set(id, body);
  }
  return out;
}

const SYSTEM =
  'Sei un traduttore editoriale specializzato in saggistica accademica. ' +
  'Traduci con precisione terminologica, mantenendo il registro dell’autore ' +
  'e senza aggiungere, omettere o riassumere nulla.';

export function isTranslateGemma(model) {
  return /(?:^|[/:])translategemma(?::|$)/i.test(String(model || ''));
}

/** Hash stabile e leggero: identifica un lavoro/checkpoint, non protegge segreti. */
export function stableTextHash(value) {
  let hash = 0x811c9dc5;
  const source = String(value || '');
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${source.length.toString(36)}-${hash.toString(16).padStart(8, '0')}`;
}

export function translationJobKey({ markdown, settings, model }) {
  return stableTextHash(JSON.stringify({
    markdown,
    sourceLang: settings?.sourceLang || 'auto',
    targetLang: settings?.targetLang || 'en',
    chunkSize: settings?.chunkSize || 5000,
    overlap: settings?.translateOverlap ?? 2,
    docContext: settings?.docContext || '',
    model: model || '',
  }));
}

function buildUser({
  group,
  sourceLang,
  targetLang,
  settings,
  specialized = false,
  retryIssue = null,
}) {
  const from = sourceLang && sourceLang !== 'auto'
    ? `dalla lingua «${languageLabel(sourceLang)}» `
    : '';
  const context = contextBlock(settings);
  const retryInstruction = retryIssue?.code === 'language'
    ? 'SECONDO TENTATIVO: la risposta precedente ha copiato o conservato la lingua sorgente. ' +
      `Traduci ogni frase in ${languageLabel(targetLang)}; non parafrasare e non restituire il testo originale.\n\n`
    : retryIssue?.code === 'scaffold' || retryIssue?.code === 'structure'
      ? 'SECONDO TENTATIVO: conserva una e una sola volta ogni segnaposto racchiuso fra ⟦ e ⟧, ' +
        'esattamente com’è scritto e nella stessa posizione logica. Traduci soltanto le parole attorno.\n\n'
      : retryIssue
        ? 'SECONDO TENTATIVO: restituisci soltanto il blocco richiesto, completo, senza copiare il contesto.\n\n'
        : '';
  return (
    (specialized
      ? `Sei un traduttore professionale ${from}verso «${languageLabel(targetLang)}». ` +
        'Traduci il brano completo con precisione editoriale, usando il contesto per mantenere coerente il lessico tecnico.\n\n'
      : `Traduci ${from}verso «${languageLabel(targetLang)}».\n\n`) +
    retryInstruction +
    (context ? `${context}\n\n` : '') +
    (group.before
      ? 'CONTESTO PRECEDENTE (NON tradurlo, non ripeterlo in risposta: serve ' +
        `solo a farti capire a cosa si riferisce il testo):\n${group.before}\n\n`
      : '') +
    (group.after
      ? 'CONTESTO SEGUENTE (NON tradurlo, non ripeterlo in risposta):\n' +
        `${group.after}\n\n`
      : '') +
    'DA TRADURRE — ogni blocco è preceduto dalla sua etichetta:\n\n' +
    renderMarked(group.blocks) +
    '\n\nRegole della risposta:\n' +
    '- restituisci TUTTE le etichette ricevute, nello stesso ordine, ognuna su ' +
    'una riga da sola seguita dalla traduzione del suo blocco;\n' +
    '- non unire né dividere i blocchi, non aggiungerne di nuovi;\n' +
    '- conserva la sintassi Markdown: i cancelletti dei titoli, le barre ' +
    'verticali delle tabelle, i trattini degli elenchi;\n' +
    '- nelle immagini `![didascalia](percorso)` traduci la didascalia e lascia ' +
    'il percorso IDENTICO, carattere per carattere;\n' +
    '- non tradurre nomi propri, sigle, riferimenti bibliografici e numeri di ' +
    'pagina; lascia in lingua originale le citazioni che l’autore riporta ' +
    'esplicitamente come tali solo se tradurle ne perderebbe il senso;\n' +
    '- nessun commento, nessuna nota, nessun blocco di codice attorno.'
  );
}

/**
 * I percorsi delle figure devono sopravvivere identici: sono nomi di file
 * scritti su disco, non testo. Se il modello li ha "tradotti" si rimettono a
 * posto in ordine, che è l'unico accostamento possibile e quello giusto
 * finché il numero di immagini non cambia.
 */
export function restoreFigurePaths(original, translated) {
  const re = /!\[([^\]]*)\]\(([^)]*)\)/gu;
  const paths = [...original.matchAll(re)].map((m) => m[2]);
  if (!paths.length) return translated;
  let i = 0;
  return translated.replace(re, (match, caption, path) => {
    const wanted = paths[i++];
    return wanted === undefined || wanted === path ? match : `![${caption}](${wanted})`;
  });
}

/**
 * Verifica che la traduzione non abbia aperto/chiuso markup inline diverso
 * dal sorgente. Conta separatamente marcatori attivi e letterali: così anche
 * `\*` → `\\*` viene rilevato, perché con due backslash l'asterisco torna
 * attivo in Markdown/Typst. Le parole possono cambiare; la struttura no.
 */
export function preservesMarkdownDelimiters(original, translated) {
  const signature = (value) => {
    const counts = new Map();
    const source = String(value || '');
    for (let i = 0; i < source.length; i++) {
      const marker = source[i];
      if (!['*', '_', '$', '`'].includes(marker)) continue;
      let slashes = 0;
      for (let j = i - 1; j >= 0 && source[j] === '\\'; j--) slashes++;
      const key = `${marker}:${slashes % 2 ? 'escaped' : 'active'}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return counts;
  };
  const before = signature(original);
  const after = signature(translated);
  const keys = new Set([...before.keys(), ...after.keys()]);
  return [...keys].every((key) => {
    const expected = before.get(key) || 0;
    const received = after.get(key) || 0;
    const [marker, state] = key.split(':');
    // Gemini tende a rendere in corsivo locuzioni latine e titoli. Una coppia
    // aggiuntiva e bilanciata di enfasi non rompe il Markdown né Typst; perdere
    // un marcatore originale o aggiungerne uno spaiato, invece, resta vietato.
    if (state === 'active' && (marker === '*' || marker === '_')) {
      return received >= expected && (received - expected) % 2 === 0;
    }
    // Escape, formule e codice sono invarianti: qui anche una coppia in più
    // può cambiare il significato o riaprire sintassi eseguibile.
    return received === expected;
  });
}

// Tutto ciò che non deve essere tradotto viene tolto temporaneamente dalla
// portata del modello. L'alternanza è ordinata dal costrutto più ampio al più
// piccolo, così i numeri dentro un URL o un DOI non generano segnaposto
// annidati. I segnaposto contengono soltanto lettere e parentesi insolite: non
// possono essere confusi con numeri, markup o parole del documento.
const TRANSLATION_SCAFFOLD_RE = /<!--[\s\S]*?-->|<\/?[a-z][\w-]*\b[^>]*>|\]\((?:\\.|[^)\n])*\)|\[\^[^\]\n]+\]|#[a-zA-Z][\w.-]*|https?:\/\/[^\s)\]]+|\b10\.\d{4,9}\/[\-._;()/:A-Z0-9]+\b|\d+(?:[.,]\d+)*(?:\s*%)?|(?:\\+)?[*_`$|]+/giu;

function alphabeticIndex(index) {
  let value = Number(index) + 1;
  let result = '';
  while (value > 0) {
    value--;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

/**
 * Protegge riferimenti e scheletro Markdown prima della traduzione.
 * `restore` fallisce se il modello perde o duplica anche un solo segnaposto:
 * non prova mai a indovinarne la posizione.
 */
export function protectTranslationScaffolding(value) {
  const entries = [];
  const text = String(value || '').replace(TRANSLATION_SCAFFOLD_RE, (original) => {
    const token = `⟦SC${alphabeticIndex(entries.length)}CS⟧`;
    entries.push({ token, original });
    return token;
  });
  return {
    text,
    entries,
    restore(candidate) {
      let restored = String(candidate || '');
      for (const entry of entries) {
        const occurrences = restored.split(entry.token).length - 1;
        if (occurrences !== 1) {
          return {
            ok: false,
            text: '',
            code: 'scaffold',
            reason: occurrences === 0
              ? 'Il modello ha rimosso un riferimento o un delimitatore protetto.'
              : 'Il modello ha duplicato un riferimento o un delimitatore protetto.',
          };
        }
        restored = restored.replace(entry.token, entry.original);
      }
      return { ok: true, text: restored, code: '', reason: '' };
    },
  };
}

const markdownTags = (value) => [...String(value || '').matchAll(/<\/?([a-z][\w-]*)\b[^>]*>/giu)]
  .map((match) => `${match[0].startsWith('</') ? '/' : ''}${match[1].toLowerCase()}`);

const markdownDestinations = (value) => [
  ...String(value || '').matchAll(/!?\[[^\]\n]*\]\(([^)\n]+)\)/gu),
].map((match) => match[1]);

/** Spiega quale parte dello scheletro Markdown è stata alterata. */
export function markdownStructureIssue(original, translated) {
  if (!preservesMarkdownDelimiters(original, translated)) {
    return 'Il modello ha alterato asterischi, underscore, formule o delimitatori inline.';
  }
  if (JSON.stringify(markdownTags(original)) !== JSON.stringify(markdownTags(translated))) {
    return 'Il modello ha perso, aggiunto o sbilanciato un tag strutturale.';
  }
  if (
    JSON.stringify(markdownDestinations(original)) !==
    JSON.stringify(markdownDestinations(translated))
  ) {
    return 'Il modello ha alterato la destinazione di un collegamento o di una figura.';
  }
  return '';
}

/** Tag, link e marker devono mantenere lo stesso scheletro fra le due lingue. */
export function preservesMarkdownStructure(original, translated) {
  return !markdownStructureIssue(original, translated);
}

/**
 * Ripristina marcatori Markdown isolati sul bordo del passaggio.
 *
 * Gli OCR usano spesso `*` o `\*` in fondo alla frase come richiamo di nota.
 * Gemini può tradurre perfettamente la prosa ma omettere quel solo glifo. Il
 * bordo è l'unico punto in cui possiamo reinserirlo senza indovinare una
 * posizione dentro la frase; i marcatori interni restano invece bloccanti.
 */
export function restoreBoundaryMarkdownMarkers(original, translated) {
  const source = String(original || '');
  let result = String(translated || '');
  const leading = source.match(/^\s*((?:\\?[*_`$])+)/u)?.[1] || '';
  const trailing = source.match(/((?:\\?[*_`$])+)\s*$/u)?.[1] || '';
  if (leading && !result.trimStart().startsWith(leading)) {
    result = leading + result.trimStart();
  }
  if (trailing && !result.trimEnd().endsWith(trailing)) {
    result = result.trimEnd() + trailing;
  }
  return result;
}

/**
 * Traduce un documento Markdown, restituendo un Markdown della stessa forma.
 *
 * @param {object} p
 * @param {object} p.settings
 * @param {string} p.markdown       testo OCR (livelli di titolo già normalizzati)
 * @param {(done:number,total:number)=>void} [p.onProgress]
 * @param {AbortSignal} [p.signal]
 * @returns {Promise<{markdown:string, blocks:number, retried:number, failed:number}>}
 */
export async function translateDocument({
  settings,
  markdown,
  onProgress,
  signal,
  resumeGroups = [],
  onCheckpoint,
  externalBefore = '',
  externalAfter = '',
}) {
  const configured = phaseConfig(settings, 'translate');
  const specialized = configured.engine === 'local' && isTranslateGemma(configured.model);
  const groups = planTranslation(markdown, {
    // Prima veniva usata, senza mostrarlo, soltanto metà della dimensione
    // scelta: un libro generava quasi il doppio delle chiamate necessarie.
    maxChars: Math.min(specialized ? 5000 : 6000, Math.max(800, settings.chunkSize || 5000)),
    overlap: settings.translateOverlap ?? 2,
  });
  if (!groups.length) throw new Error('Non c’è testo da tradurre.');
  if (externalBefore.trim()) groups[0].before = externalBefore.trim();
  if (externalAfter.trim()) groups.at(-1).after = externalAfter.trim();
  const units = new Map(groups.flatMap((group) => group.blocks.map((block) => [block.id, block])));

  const sourceLang = settings.sourceLang || 'auto';
  const targetLang = settings.targetLang || 'en';
  const guardLanguage = settings.translationLanguageGuard !== false;
  const pieces = new Map();
  let retried = 0;
  let failed = 0;
  const failedBlockIds = [];
  const failedBlockReasons = new Map();
  const resumed = new Map((resumeGroups || []).map((item) => [item.index, item]));

  for (const group of groups) {
    if (signal?.aborted) throw new DOMException('Traduzione annullata.', 'AbortError');
    const signature = stableTextHash(renderMarked(group.blocks));
    const checkpoint = resumed.get(group.index);
    if (
      checkpoint?.signature === signature &&
      Array.isArray(checkpoint.pieces) &&
      !(Number(checkpoint.failed) > 0)
    ) {
      for (const [id, text] of checkpoint.pieces) pieces.set(Number(id), text);
      retried += Number(checkpoint.retried) || 0;
      failed += Number(checkpoint.failed) || 0;
      onProgress?.(group.index + 1, groups.length, true);
      continue;
    }
    onProgress?.(group.index, groups.length, false);
    const retriedBefore = retried;
    const failedBefore = failed;
    const failedIdsBefore = failedBlockIds.length;

    const translatable = group.blocks.filter((b) => b.translate);
    const protectedBlocks = new Map(translatable.map((block) => [
      block.id,
      protectTranslationScaffolding(block.text),
    ]));
    const promptBlock = (block) => ({ ...block, text: protectedBlocks.get(block.id).text });
    const firstIssues = new Map();
    const assessProtectedCandidate = (block, value, contextGroup = group) => {
      if (!String(value || '').trim()) {
        return {
          ok: false,
          text: '',
          code: 'empty',
          reason: 'Il modello non ha restituito il blocco richiesto.',
        };
      }
      const scaffold = protectedBlocks.get(block.id).restore(value);
      if (!scaffold.ok) return scaffold;
      const restored = restoreFigurePaths(block.text, scaffold.text);
      return assessTranslationCandidate({
        original: block.text,
        candidate: restored,
        previous: contextGroup.before,
        next: contextGroup.after,
        previousSource: units.get(block.id - 1)?.text,
        previousTranslation: pieces.get(block.id - 1),
        targetLang,
        sourceLang,
        guardLanguage,
      });
    };
    for (const block of group.blocks) {
      if (!block.translate) pieces.set(block.id, block.text);
    }
    if (!translatable.length) {
      await onCheckpoint?.({
        index: group.index,
        signature,
        pieces: group.blocks.map((block) => [block.id, pieces.get(block.id)]),
        retried: 0,
        failed: 0,
        failedIds: [],
      });
      continue;
    }

    // Un gruppo che fallisce non deve buttare via il documento: si ripiega
    // sui blocchi singoli, che è già la strada per i blocchi mancanti. Su un
    // libro, perdere tutto per una risposta vuota a metà è il danno peggiore.
    let parsed = new Map();
    try {
      const answer = await engineChat({
        settings,
        phase: 'translate',
        // TranslateGemma segue il proprio template User/Assistant e rende
        // meglio se l'istruzione professionale vive nello stesso messaggio.
        system: specialized ? undefined : SYSTEM,
        user: buildUser({
          group: { ...group, blocks: translatable.map(promptBlock) },
          sourceLang,
          targetLang,
          settings,
          specialized,
        }),
        // Zero: una traduzione non guadagna nulla dalla varianza, e la
        // ripetibilità permette di riprendere un documento interrotto.
        temperature: 0,
        maxTokens: 4096,
        reasoningEffort: 'none',
        signal,
      });
      parsed = parseMarked(answer);
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') throw error;
    }

    for (const block of translatable) {
      const value = parsed.get(block.id);
      if (value) {
        const assessment = assessProtectedCandidate(block, value);
        if (assessment.ok) {
          pieces.set(block.id, assessment.text);
          continue;
        }
        firstIssues.set(block.id, assessment);
      } else {
        firstIssues.set(block.id, {
          code: 'missing',
          reason: 'Il modello non ha restituito il blocco richiesto.',
        });
      }
      // Blocco saltato: si ritenta da solo, dove non può perdersi fra gli altri.
      retried++;
      try {
        const firstIssue = firstIssues.get(block.id);
        // Se il primo tentativo ha copiato la lingua sorgente, togliere il
        // contesto rende il secondo prompt sostanzialmente diverso anche con
        // temperatura zero e impedisce che il modello replichi la stessa
        // continuazione. Negli altri casi il contesto resta utile al lessico.
        const retryGroup = firstIssue?.code === 'language'
          ? { ...group, before: '', after: '', blocks: [promptBlock(block)] }
          : { ...group, blocks: [promptBlock(block)] };
        const single = await engineChat({
          settings,
          phase: 'translate',
          system: specialized ? undefined : SYSTEM,
          user: buildUser({
            group: retryGroup,
            sourceLang,
            targetLang,
            settings,
            specialized,
            retryIssue: firstIssue,
          }),
          temperature: 0,
          maxTokens: 3072,
          reasoningEffort: 'none',
          signal,
        });
        const one = parseMarked(single).get(block.id);
        // Senza etichetta si accetta la risposta nuda, purché non sia vuota:
        // in una richiesta con un blocco solo non c'è ambiguità su cosa sia.
        const body = one || single.replace(MARK_RE, '').trim();
        if (!body) throw new Error('risposta vuota');
        const assessment = assessProtectedCandidate(block, body, retryGroup);
        if (!assessment.ok) throw new Error(assessment.reason);
        pieces.set(block.id, assessment.text);
      } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') throw error;
        // Un blocco perso non deve far perdere il documento: resta in lingua
        // originale ed è segnalato nel riepilogo.
        failed++;
        failedBlockIds.push(block.id);
        failedBlockReasons.set(
          block.id,
          String(error?.message || 'Il modello non ha restituito una traduzione utilizzabile.')
            .replace(/\s+/gu, ' ')
            .trim()
            .slice(0, 220),
        );
        pieces.set(block.id, block.text);
      }
    }
    await onCheckpoint?.({
      index: group.index,
      signature,
      pieces: group.blocks.map((block) => [block.id, pieces.get(block.id)]),
      retried: retried - retriedBefore,
      failed: failed - failedBefore,
      failedIds: failedBlockIds.slice(failedIdsBefore),
    });
  }
  onProgress?.(groups.length, groups.length);

  const ordered = [...pieces.keys()].sort((a, b) => a - b);
  const groupedBySource = new Map();
  for (const id of ordered) {
    const sourceId = units.get(id)?.sourceId ?? id;
    if (!groupedBySource.has(sourceId)) groupedBySource.set(sourceId, []);
    groupedBySource.get(sourceId).push(pieces.get(id));
  }
  const failedSet = new Set(failedBlockIds);
  const unitsBySource = new Map();
  for (const unit of units.values()) {
    const sourceId = unit.sourceId ?? unit.id;
    if (!unitsBySource.has(sourceId)) unitsBySource.set(sourceId, []);
    unitsBySource.get(sourceId).push(unit.id);
  }
  const blockTranslations = splitBlocks(markdown).map((block) => {
    const failedUnitIds = (unitsBySource.get(block.id) || []).filter((id) => failedSet.has(id));
    const failureReasons = [...new Set(
      failedUnitIds.map((id) => failedBlockReasons.get(id)).filter(Boolean),
    )];
    return {
      id: block.id,
      before: block.text,
      // Le unità nascono da frasi dello stesso paragrafo: uno spazio le
      // ricompone senza introdurre nuovi capoversi nel rebase selettivo.
      after: (groupedBySource.get(block.id) || [block.text]).join(' ').trim(),
      // Il rebase selettivo deve poter scartare il solo paragrafo che contiene
      // una frase non sicura, senza buttare via gli altri paragrafi del lotto.
      failed: failedUnitIds.length > 0,
      failedUnitIds,
      failureReason: failureReasons.join(' · '),
    };
  });
  return {
    markdown: ordered.map((id) => pieces.get(id)).join('\n\n'),
    blocks: ordered.length,
    blockTranslations,
    retried,
    failed,
    failedBlockIds,
    failedBlockReasons: Object.fromEntries(failedBlockReasons),
  };
}

function reviewParagraphKey(value) {
  return String(value || '')
    .replace(/<!--[^>]*-->/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]+\)/g, ' $1 ')
    .replace(/<[^>]+>|[#*_`|]/g, ' ')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function contextEchoVariants(value) {
  const raw = String(value || '').trim();
  if (!raw) return [];
  return [raw, ...splitSentences(raw).map((sentence) => sentence.trim())]
    .filter((item) => item.length >= 24)
    .filter((item, index, all) => all.indexOf(item) === index)
    .sort((a, b) => b.length - a.length);
}

function stripExactContextEcho(candidate, previous, next) {
  let text = String(candidate || '').trim();
  const variants = [...contextEchoVariants(previous), ...contextEchoVariants(next)];
  let changed = true;
  while (changed && text) {
    changed = false;
    for (const context of variants) {
      if (text === context) return '';
      if (text.startsWith(context) && /^\s+/u.test(text.slice(context.length))) {
        text = text.slice(context.length).trimStart();
        changed = true;
        break;
      }
      if (text.endsWith(context)) {
        const prefix = text.slice(0, -context.length);
        if (/\s+$/u.test(prefix)) {
          text = prefix.trimEnd();
          changed = true;
          break;
        }
      }
    }
  }
  return text;
}

function hasDegenerateSentenceLoop(candidate) {
  const sentences = splitSentences(candidate)
    .map((sentence) => ({ raw: sentence, key: reviewParagraphKey(sentence) }))
    .filter((sentence) => sentence.key.length >= 40);
  let run = 1;
  for (let index = 1; index < sentences.length; index++) {
    run = sentences[index].key === sentences[index - 1].key ? run + 1 : 1;
    if (run >= 3) return true;
  }
  return false;
}

/** Un output adiacente identico è sospetto solo se i due sorgenti erano diversi. */
export function isUnexpectedAdjacentTranslation({
  source,
  previousSource,
  candidate,
  previousTranslation,
}) {
  const translatedKey = reviewParagraphKey(candidate);
  if (translatedKey.length < 80 || translatedKey !== reviewParagraphKey(previousTranslation)) return false;
  return reviewParagraphKey(source) !== reviewParagraphKey(previousSource);
}

/**
 * Ripulisce una risposta di revisione senza interpretarne il significato.
 * Un input è un solo blocco: copie del blocco corrente, del contesto o della
 * traduzione stessa vengono eliminate; se restano più blocchi distinti la
 * proposta è ambigua e viene rifiutata.
 */
export function sanitizeTranslationCandidate({ current, candidate, previous = '', next = '' }) {
  const raw = stripExactContextEcho(String(candidate || '')
    .trim()
    .replace(/^```(?:markdown|md)?\s*\n?/i, '')
    .replace(/\n?```$/i, '')
    .trim(), previous, next);
  if (!raw) return '';
  // Un modello locale sotto pressione può entrare in loop e ripetere la
  // stessa frase molte volte. Non comprimiamo alla cieca: rifiutare il blocco
  // lo fa ritentare da solo e, se persiste, conserva l'originale segnalato.
  if (hasDegenerateSentenceLoop(raw)) return '';
  const segments = raw.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const unique = [];
  for (const segment of segments) {
    const key = reviewParagraphKey(segment);
    if (!key || unique.some((item) => item.key === key)) continue;
    unique.push({ text: segment, key });
  }
  if (!unique.length) return '';

  const currentKey = reviewParagraphKey(current);
  const contextKeys = new Set([reviewParagraphKey(previous), reviewParagraphKey(next)].filter(Boolean));
  let filtered = unique;
  if (filtered.length > 1) {
    filtered = filtered.filter((item) => !contextKeys.has(item.key));
  }
  // Errore tipico: il modello restituisce prima l'originale e poi la versione
  // corretta. Se esiste un'alternativa, la copia esatta dell'input non è parte
  // della correzione.
  if (filtered.length > 1 && filtered.some((item) => item.key === currentKey)) {
    filtered = filtered.filter((item) => item.key !== currentKey);
  }
  return filtered.length === 1 ? filtered[0].text : '';
}

/**
 * Valuta una singola proposta e restituisce anche il motivo preciso dello
 * scarto. Il chiamante può così distinguere un vero rischio strutturale da
 * una risposta vuota o rimasta nella lingua sorgente.
 */
export function assessTranslationCandidate({
  original,
  candidate,
  previous = '',
  next = '',
  previousSource = '',
  previousTranslation = '',
  targetLang = 'it',
  sourceLang = 'auto',
  guardLanguage = true,
}) {
  if (!String(candidate || '').trim()) {
    return { ok: false, text: '', code: 'empty', reason: 'Il modello ha restituito una risposta vuota.' };
  }
  const withBoundaryMarkers = restoreBoundaryMarkdownMarkers(original, candidate);
  const cleaned = sanitizeTranslationCandidate({
    current: original,
    candidate: withBoundaryMarkers,
    previous,
    next,
  });
  if (!cleaned) {
    return {
      ok: false,
      text: '',
      code: 'ambiguous',
      reason: 'La risposta conteneva copie, contesto o ripetizioni e non era isolabile in modo sicuro.',
    };
  }
  const structureIssue = markdownStructureIssue(original, cleaned);
  if (structureIssue) {
    return { ok: false, text: '', code: 'structure', reason: structureIssue };
  }
  if (isUnexpectedAdjacentTranslation({
    source: original,
    previousSource,
    candidate: cleaned,
    previousTranslation,
  })) {
    return {
      ok: false,
      text: '',
      code: 'duplicate',
      reason: 'La risposta duplicava in modo inatteso la traduzione del passaggio precedente.',
    };
  }
  if (guardLanguage && !isTranslationLanguageSafe(original, cleaned, targetLang, sourceLang)) {
    return {
      ok: false,
      text: '',
      code: 'language',
      reason: 'La risposta risulta ancora prevalentemente nella lingua sorgente.',
    };
  }
  return { ok: true, text: cleaned, code: '', reason: '' };
}
