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
      units.push(block);
      continue;
    }
    const sentences = splitSentences(block.text);
    let buffer = '';
    for (const sentence of sentences) {
      if (buffer && buffer.length + sentence.length > maxChars) {
        units.push({ ...block, id: units.length, text: buffer.trimEnd() });
        buffer = '';
      }
      buffer += sentence;
    }
    if (buffer.trim()) units.push({ ...block, id: units.length, text: buffer.trimEnd() });
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

function buildUser({ group, sourceLang, targetLang, settings }) {
  const from = sourceLang && sourceLang !== 'auto'
    ? `dalla lingua «${languageLabel(sourceLang)}» `
    : '';
  const context = contextBlock(settings);
  return (
    `Traduci ${from}verso «${languageLabel(targetLang)}».\n\n` +
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
  return [...keys].every((key) => before.get(key) === after.get(key));
}

/** Tag, link e marker devono mantenere lo stesso scheletro fra le due lingue. */
export function preservesMarkdownStructure(original, translated) {
  if (!preservesMarkdownDelimiters(original, translated)) return false;
  const tags = (value) => [...String(value || '').matchAll(/<\/?([a-z][\w-]*)\b[^>]*>/giu)]
    .map((match) => `${match[0].startsWith('</') ? '/' : ''}${match[1].toLowerCase()}`);
  const destinations = (value) => [
    ...String(value || '').matchAll(/!?\[[^\]\n]*\]\(([^)\n]+)\)/gu),
  ].map((match) => match[1]);
  return (
    JSON.stringify(tags(original)) === JSON.stringify(tags(translated)) &&
    JSON.stringify(destinations(original)) === JSON.stringify(destinations(translated))
  );
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
export async function translateDocument({ settings, markdown, onProgress, signal }) {
  const groups = planTranslation(markdown, {
    maxChars: Math.min(4000, Math.max(800, Math.round((settings.chunkSize || 5000) / 2))),
    overlap: settings.translateOverlap ?? 2,
  });
  if (!groups.length) throw new Error('Non c’è testo da tradurre.');

  const sourceLang = settings.sourceLang || 'auto';
  const targetLang = settings.targetLang || 'en';
  const pieces = new Map();
  let retried = 0;
  let failed = 0;

  for (const group of groups) {
    if (signal?.aborted) throw new DOMException('Traduzione annullata.', 'AbortError');
    onProgress?.(group.index, groups.length);

    const translatable = group.blocks.filter((b) => b.translate);
    for (const block of group.blocks) {
      if (!block.translate) pieces.set(block.id, block.text);
    }
    if (!translatable.length) continue;

    // Un gruppo che fallisce non deve buttare via il documento: si ripiega
    // sui blocchi singoli, che è già la strada per i blocchi mancanti. Su un
    // libro, perdere tutto per una risposta vuota a metà è il danno peggiore.
    let parsed = new Map();
    try {
      const answer = await engineChat({
        settings,
        phase: 'translate',
        system: SYSTEM,
        user: buildUser({ group: { ...group, blocks: translatable }, sourceLang, targetLang, settings }),
        // Zero: una traduzione non guadagna nulla dalla varianza, e la
        // ripetibilità permette di riprendere un documento interrotto.
        temperature: 0,
        maxTokens: 8192,
        signal,
      });
      parsed = parseMarked(answer);
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') throw error;
    }

    for (const block of translatable) {
      const value = parsed.get(block.id);
      if (value) {
        const restored = restoreFigurePaths(block.text, value);
        if (preservesMarkdownStructure(block.text, restored)) {
          pieces.set(block.id, restored);
          continue;
        }
      }
      // Blocco saltato: si ritenta da solo, dove non può perdersi fra gli altri.
      retried++;
      try {
        const single = await engineChat({
          settings,
          phase: 'translate',
          system: SYSTEM,
          user: buildUser({
            group: { ...group, blocks: [block] },
            sourceLang,
            targetLang,
            settings,
          }),
          temperature: 0,
          maxTokens: 4096,
          signal,
        });
        const one = parseMarked(single).get(block.id);
        // Senza etichetta si accetta la risposta nuda, purché non sia vuota:
        // in una richiesta con un blocco solo non c'è ambiguità su cosa sia.
        const body = one || single.replace(MARK_RE, '').trim();
        if (!body) throw new Error('risposta vuota');
        const restored = restoreFigurePaths(block.text, body);
        if (!preservesMarkdownStructure(block.text, restored)) {
          throw new Error('sintassi Markdown alterata');
        }
        pieces.set(block.id, restored);
      } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') throw error;
        // Un blocco perso non deve far perdere il documento: resta in lingua
        // originale ed è segnalato nel riepilogo.
        failed++;
        pieces.set(block.id, block.text);
      }
    }
  }
  onProgress?.(groups.length, groups.length);

  const ordered = [...pieces.keys()].sort((a, b) => a - b);
  return {
    markdown: ordered.map((id) => pieces.get(id)).join('\n\n'),
    blocks: ordered.length,
    retried,
    failed,
  };
}
