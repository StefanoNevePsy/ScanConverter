/*
  Controllo locale della lingua nei documenti tradotti.

  Non pretende di sostituire un language detector statistico: cerca segnali ad
  alta precisione (parole-funzione) in passaggi abbastanza lunghi. È quindi
  adatto a trovare pagine rimaste quasi interamente nella lingua sorgente,
  senza spedire di nuovo l'intero libro a un modello.
*/

const PROFILES = {
  it: 'il lo la i gli le un uno una e ed di del dello della dei degli delle a al allo alla ai agli alle da dal dallo dalla dai dagli dalle in nel nello nella nei negli nelle con su per tra fra che chi cui come questo questa questi queste quello quella sono era erano essere stato stata non più anche ma o ha hanno aveva ogni altro altri quando dove mentre perché quindi'.split(' '),
  en: 'the a an and of to in is are was were be been being that this these those for with from by on at as it its his her their our your not but or have has had which who what when where how into than then also more may can could would should each other between through about one all'.split(' '),
  fr: 'le la les un une des et de du au aux à en est sont était étaient être que qui dont pour avec par sur dans ce cette ces son sa ses leur leurs ne pas mais ou plus aussi comme quand où entre chaque autre'.split(' '),
  de: 'der die das ein eine einer und von zu im in ist sind war waren sein dass dieser diese dieses für mit aus durch auf als es seine ihre nicht aber oder haben hat hatte welcher welche wenn wo wie zwischen auch mehr jeder andere'.split(' '),
  es: 'el la los las un una unos unas y de del al en es son era eran ser que quien para con por sobre este esta estos estas su sus no pero o más también como cuando donde entre cada otro'.split(' '),
  pt: 'o a os as um uma uns umas e de do da dos das ao aos em no na nos nas é são era eram ser que quem para com por sobre este esta estes estas seu sua seus suas não mas ou mais também como quando onde entre cada outro'.split(' '),
};

const SETS = Object.fromEntries(
  Object.entries(PROFILES).map(([code, words]) => [code, new Set(words)]),
);

const REFERENCE_HEADING_RE = /^(?:#{1,6}\s*)?(?:riferimenti|bibliografia|references|bibliography|subject index|author index|indice analitico|indice degli autori)\b/imu;

function plainText(value) {
  return String(value || '')
    .replace(/<!--[^>]*-->/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]+\)/g, ' $1 ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\\[a-zA-Z]+|[#*_`|]/g, ' ');
}

function duplicateKey(value) {
  return plainText(value)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function wordCount(value) {
  return duplicateKey(value).split(' ').filter(Boolean).length;
}

function sentenceRanges(value) {
  const text = String(value || '');
  const ranges = [];
  const pushRange = (rawStart, rawEnd) => {
    let start = rawStart;
    let end = rawEnd;
    while (start < end && /\s/u.test(text[start])) start++;
    while (end > start && /\s/u.test(text[end - 1])) end--;
    if (start < end) ranges.push({ start, end, text: text.slice(start, end) });
  };
  if (typeof Intl?.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter('it', { granularity: 'sentence' });
    for (const segment of segmenter.segment(text)) {
      pushRange(segment.index, segment.index + segment.segment.length);
    }
    return ranges;
  }
  const matcher = /[^.!?…]+(?:[.!?…]+[\])}"'»”’]*|$)/gu;
  for (const match of text.matchAll(matcher)) pushRange(match.index, match.index + match[0].length);
  return ranges;
}

function wordTokens(value) {
  const text = String(value || '');
  return [...text.matchAll(/[\p{L}\p{N}][\p{L}\p{M}\p{N}'’\-]*/gu)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    key: match[0]
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .toLocaleLowerCase(),
  }));
}

function repeatedSentenceItems(passage) {
  const sentences = sentenceRanges(passage.text);
  const items = [];
  for (let index = 1; index < sentences.length; index++) {
    const previous = sentences[index - 1];
    const current = sentences[index];
    const key = duplicateKey(current.text);
    if (key.length < 45 || wordCount(current.text) < 8 || key !== duplicateKey(previous.text)) continue;
    let end = current.end;
    while (end < passage.text.length && /\s/u.test(passage.text[end])) end++;
    items.push({
      id: `duplicate-sentence-${passage.start + current.start}-${passage.start + end}`,
      type: 'sentence',
      page: passage.page,
      start: passage.start + current.start,
      end: passage.start + end,
      duplicateOfStart: passage.start + previous.start,
      text: current.text,
      sample: plainText(current.text).replace(/\s+/g, ' ').trim().slice(0, 240),
      recommended: true,
    });
  }
  return items;
}

function repeatedFragmentItems(passage) {
  const tokens = wordTokens(passage.text);
  const items = [];
  const recent = new Map();
  const minimumWords = 8;
  const maximumWords = 48;
  for (let index = 0; index + minimumWords <= tokens.length; index++) {
    const anchor = tokens.slice(index, index + minimumWords).map((token) => token.key).join(' ');
    const previous = recent.get(anchor);
    recent.set(anchor, index);
    if (previous == null) continue;
    const length = index - previous;
    if (length < minimumWords || length > maximumWords || index + length > tokens.length) continue;
    let equal = true;
    for (let offset = 0; offset < length; offset++) {
      if (tokens[previous + offset].key !== tokens[index + offset].key) {
        equal = false;
        break;
      }
    }
    if (!equal) continue;
    const firstText = passage.text.slice(tokens[previous].start, tokens[index - 1].end);
    if (duplicateKey(firstText).length < 45) continue;
    // Si elimina il separatore dopo la prima copia insieme alla seconda copia,
    // conservando invece la punteggiatura finale della seconda occorrenza.
    const localStart = tokens[index - 1].end;
    const localEnd = tokens[index + length - 1].end;
    items.push({
      id: `duplicate-fragment-${passage.start + localStart}-${passage.start + localEnd}`,
      type: 'fragment',
      page: passage.page,
      start: passage.start + localStart,
      end: passage.start + localEnd,
      duplicateOfStart: passage.start + tokens[previous].start,
      text: firstText,
      sample: plainText(firstText).replace(/\s+/g, ' ').trim().slice(0, 240),
      recommended: true,
    });
  }
  return items;
}

function classify(text) {
  const first = text.trimStart();
  if (/^#{1,6}\s/.test(first)) return 'heading';
  if (/^!\[/.test(first)) return 'figure';
  if (/^\|/.test(first) || /\\begin\{tabular\}/.test(first)) return 'table';
  if (/^([-*+]|\d+[.)])\s/.test(first)) return 'list';
  return 'prose';
}

function referenceLike(text, words) {
  const years = (text.match(/\b(?:18|19|20)\d{2}\b/g) || []).length;
  const breaks = (text.match(/<br\s*\/?>/gi) || []).length;
  const numberedEntries = (text.match(/^\s*\d{1,3}[.)]\s+/gm) || []).length;
  return REFERENCE_HEADING_RE.test(text) || (
    words.length >= 20 && (years >= 3 || breaks >= 6 || numberedEntries >= 4)
  );
}

/** Passaggi con offset esatti, confinati entro una singola pagina. */
export function documentLanguagePassages(markdown) {
  const source = String(markdown || '');
  const markers = [...source.matchAll(/<!--\s*pagina\s+(\d+)\s*-->/giu)];
  const regions = markers.length
    ? markers.map((marker, index) => ({
        page: Number(marker[1]),
        start: marker.index + marker[0].length,
        end: index + 1 < markers.length ? markers[index + 1].index : source.length,
      }))
    : [{ page: null, start: 0, end: source.length }];
  const passages = [];
  for (const region of regions) {
    const regionText = source.slice(region.start, region.end);
    const pieces = regionText.split(/(\n{2,})/);
    let offset = region.start;
    let pageIndex = 0;
    for (const piece of pieces) {
      if (/^\n{2,}$/.test(piece)) {
        offset += piece.length;
        continue;
      }
      const leading = piece.match(/^\s*/u)?.[0].length || 0;
      const trailing = piece.match(/\s*$/u)?.[0].length || 0;
      const text = piece.slice(leading, Math.max(leading, piece.length - trailing));
      const start = offset + leading;
      offset += piece.length;
      if (!text.trim()) continue;
      const kind = classify(text);
      const translate = /\p{L}{2,}/u.test(plainText(text));
      passages.push({
        id: `p${region.page ?? 0}-b${pageIndex++}`,
        page: region.page,
        text,
        start,
        end: start + text.length,
        kind,
        translate,
      });
    }
  }
  // Una bibliografia/indice continua per molte pagine: la sua intestazione è
  // un blocco diverso dalle singole voci, quindi il contesto va propagato fino
  // al prossimo vero titolo di sezione.
  let referenceSection = false;
  for (const passage of passages) {
    if (passage.kind === 'heading') {
      if (REFERENCE_HEADING_RE.test(passage.text)) referenceSection = true;
      else if (/^#{1,3}\s+/u.test(passage.text)) referenceSection = false;
    }
    passage.referenceSection = referenceSection;
  }
  return passages;
}

export function detectPassageLanguage(text, targetLang = 'it', sourceLang = 'auto') {
  const words = (plainText(text).toLocaleLowerCase().match(/\p{L}{2,}/gu) || []);
  const hits = Object.fromEntries(
    Object.entries(SETS).map(([code, set]) => [code, words.reduce((n, word) => n + (set.has(word) ? 1 : 0), 0)]),
  );
  const candidates = Object.keys(SETS).filter((code) => code !== targetLang);
  let detectedLang = candidates.sort((a, b) => hits[b] - hits[a])[0] || sourceLang;
  if (sourceLang !== 'auto' && sourceLang !== targetLang && SETS[sourceLang]) {
    if (hits[sourceLang] >= (hits[detectedLang] || 0) - 1) detectedLang = sourceLang;
  }
  const sourceHits = hits[detectedLang] || 0;
  const targetHits = hits[targetLang] || 0;
  const evidence = sourceHits + targetHits;
  const confidence = evidence ? sourceHits / evidence : 0;
  const suspicious = words.length >= 15 && sourceHits >= 5 && sourceHits >= targetHits + 3 && confidence >= 0.65;
  return {
    words: words.length,
    hits,
    detectedLang,
    sourceHits,
    targetHits,
    confidence,
    suspicious,
    referenceLike: referenceLike(text, words),
  };
}

/**
 * Ricava la lingua dominante del documento per i vecchi progetti esportati
 * prima che sourceLanguage/targetLanguage venissero salvate. Si sommano solo
 * parole-funzione: termini tecnici, nomi propri e citazioni incidono poco.
 */
export function inferDocumentLanguage(markdown, fallback = 'it') {
  const words = (plainText(markdown).toLocaleLowerCase().match(/\p{L}{2,}/gu) || []);
  const scores = Object.fromEntries(
    Object.entries(SETS).map(([code, set]) => [
      code,
      words.reduce((total, word) => total + (set.has(word) ? 1 : 0), 0),
    ]),
  );
  const ranked = Object.keys(scores).sort((a, b) => scores[b] - scores[a]);
  return (scores[ranked[0]] || 0) >= 5 ? ranked[0] : (SETS[fallback] ? fallback : 'it');
}

/**
 * Guardia ad alta precisione per le risposte del modello. I riferimenti
 * bibliografici possono dover conservare titoli originali, quindi non vengono
 * respinti; nella prosa, invece, una lingua dominante diversa dal target
 * rende la risposta non sicura e forza il normale ritentativo del blocco.
 */
export function isTranslationLanguageSafe(
  original,
  translated,
  targetLang = 'it',
  sourceLang = 'auto',
) {
  const before = detectPassageLanguage(original, targetLang, sourceLang);
  if (before.referenceLike) return true;
  const expectedSource = before.suspicious ? before.detectedLang : sourceLang;
  return !detectPassageLanguage(translated, targetLang, expectedSource).suspicious;
}

export function auditDocumentLanguage(markdown, targetLang = 'it', sourceLang = 'auto') {
  const passages = documentLanguagePassages(markdown);
  const items = passages
    .filter((passage) => passage.translate)
    .map((passage) => ({ ...passage, ...detectPassageLanguage(passage.text, targetLang, sourceLang) }))
    .filter((passage) => passage.suspicious)
    .map((passage) => ({
      ...passage,
      recommended: !passage.referenceLike && !passage.referenceSection && passage.kind !== 'table',
      sample: plainText(passage.text).replace(/\s+/g, ' ').trim().slice(0, 240),
    }));
  return {
    targetLang,
    sourceLang,
    totalPassages: passages.length,
    items,
    pages: [...new Set(items.map((item) => item.page).filter(Number.isFinite))],
    recommended: items.filter((item) => item.recommended).length,
  };
}

/**
 * Trova soltanto duplicati adiacenti praticamente certi. La chiave ignora
 * markup, maiuscole, accenti e punteggiatura, ma richiede prosa abbastanza
 * lunga, stessa pagina e stessa sequenza di parole: niente deduplicazione
 * "semantica" che potrebbe eliminare una ripetizione intenzionale.
 */
export function findAdjacentDuplicatePassages(markdown) {
  const passages = documentLanguagePassages(markdown).filter((passage) => (
    passage.translate && passage.kind === 'prose' && !passage.referenceSection
  ));
  const duplicates = [];
  for (let index = 1; index < passages.length; index++) {
    const previous = passages[index - 1];
    const passage = passages[index];
    if (previous.page !== passage.page) continue;
    const key = duplicateKey(passage.text);
    if (key.length < 50 || key.split(' ').length < 9 || key !== duplicateKey(previous.text)) continue;
    duplicates.push({ ...passage, duplicateOf: previous.id });
  }
  return duplicates;
}

/**
 * Cerca ripetizioni esatte consecutive ad alta confidenza, senza LLM.
 * L'ordine di precedenza evita suggerimenti sovrapposti: un intero paragrafo
 * duplicato non viene segnalato anche come frase o frammento duplicato.
 */
export function auditDocumentDuplicates(markdown) {
  const passages = documentLanguagePassages(markdown).filter((passage) => (
    passage.translate && passage.kind === 'prose' && !passage.referenceSection
  ));
  const candidates = [];
  for (const duplicate of findAdjacentDuplicatePassages(markdown)) {
    candidates.push({
      ...duplicate,
      id: `duplicate-paragraph-${duplicate.start}-${duplicate.end}`,
      type: 'paragraph',
      duplicateOfStart: passages.find((item) => item.id === duplicate.duplicateOf)?.start ?? null,
      sample: plainText(duplicate.text).replace(/\s+/g, ' ').trim().slice(0, 240),
      recommended: true,
    });
  }
  for (const passage of passages) {
    candidates.push(...repeatedSentenceItems(passage), ...repeatedFragmentItems(passage));
  }
  const priority = { paragraph: 0, sentence: 1, fragment: 2 };
  const accepted = [];
  for (const candidate of candidates.sort((a, b) => (
    priority[a.type] - priority[b.type] || a.start - b.start || b.end - a.end
  ))) {
    if (accepted.some((item) => candidate.start < item.end && candidate.end > item.start)) continue;
    accepted.push(candidate);
  }
  const items = accepted.sort((a, b) => a.start - b.start);
  return {
    totalPassages: passages.length,
    items,
    counts: {
      paragraphs: items.filter((item) => item.type === 'paragraph').length,
      sentences: items.filter((item) => item.type === 'sentence').length,
      fragments: items.filter((item) => item.type === 'fragment').length,
    },
  };
}

function countExactNormalizedPassages(normalizedDocument, normalizedPassage) {
  if (!normalizedPassage) return 0;
  const haystack = ` ${normalizedDocument} `;
  const needle = ` ${normalizedPassage} `;
  let count = 0;
  let cursor = 0;
  while (cursor < haystack.length) {
    const index = haystack.indexOf(needle, cursor);
    if (index === -1) break;
    count++;
    cursor = index + needle.length;
  }
  return count;
}

/**
 * Allinea gli avvisi nati dal testo canonico con il Typst effettivamente
 * aperto nell'editor. Ogni voce rappresenta una copia oltre la prima: se nel
 * sorgente di lavoro ne rimane una sola, l'avviso è ormai obsoleto e sparisce
 * senza modificare retroattivamente il testo base.
 */
export function reconcileDuplicateAuditWithWorkingText(audit, workingText) {
  if (!audit || !String(workingText || '').trim() || !audit.items?.length) return audit;
  const normalizedDocument = duplicateKey(workingText);
  const capacityByKey = new Map();
  const usedByKey = new Map();
  const items = audit.items.filter((item) => {
    const key = duplicateKey(item.text);
    if (!capacityByKey.has(key)) {
      const occurrences = countExactNormalizedPassages(normalizedDocument, key);
      capacityByKey.set(key, Math.max(0, occurrences - 1));
    }
    const used = usedByKey.get(key) || 0;
    const keep = used < capacityByKey.get(key);
    if (keep) usedByKey.set(key, used + 1);
    return keep;
  });
  return {
    ...audit,
    items,
    reconciledWithWorkingText: true,
    hiddenFromWorkingText: audit.items.length - items.length,
    counts: {
      paragraphs: items.filter((item) => item.type === 'paragraph').length,
      sentences: items.filter((item) => item.type === 'sentence').length,
      fragments: items.filter((item) => item.type === 'fragment').length,
    },
  };
}

/** Accetta `251, 285-286, 306`; rifiuta input ambiguo o intervalli enormi. */
export function parsePageSelection(value) {
  const source = String(value || '').trim();
  if (!source) return [];
  const pages = new Set();
  for (const token of source.split(/[;,\s]+/).filter(Boolean)) {
    const match = token.match(/^(\d+)(?:-(\d+))?$/);
    if (!match) throw new Error(`Intervallo pagina non valido: «${token}».`);
    const first = Number(match[1]);
    const last = Number(match[2] || match[1]);
    if (first < 1 || last < first || last - first > 200) {
      throw new Error(`Intervallo pagina non valido: «${token}».`);
    }
    for (let page = first; page <= last; page++) pages.add(page);
  }
  return [...pages].sort((a, b) => a - b);
}
