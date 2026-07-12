/*
  Controllo ortografico del documento (italiano + inglese) per scovare i
  refusi dell'OCR («circularita» → «circolarità»). I dizionari sono liste
  piatte di forme flesse generate a build-time con `unmunch` dai dizionari
  Hunspell di LibreOffice (it_IT, en_US) e ripulite intersecandole con le
  liste di frequenza reali (le sole voci Hunspell caricano in minuti; un Set
  di forme carica in millisecondi). Tutto locale, nessuna rete.

  Le parole sconosciute a ENTRAMBI i dizionari diventano "sospette" e possono
  essere corrette in blocco da un LLM veloce, passando SOLO parola + breve
  contesto (requestSpellFixes): mai il documento intero.
*/

import { nvidiaChat } from './nvidia.js';
import { geminiGenerate } from './gemini.js';
import { extractJson } from './aifix.js';

// Token Typst/tecnici che non sono refusi anche se ignoti ai dizionari.
const WHITELIST = new Set([
  'typst', 'frac', 'sqrt', 'dots', 'arrow', 'macron', 'overline', 'underline',
  'upright', 'smallcaps', 'footnote', 'parbreak', 'linebreak', 'pagebreak',
  'libertinus', 'dejavu', 'sans', 'serif', 'mono', 'monospazio', 'ocr',
  'png', 'jpg', 'pdf', 'svg', 'bbox', 'nemotron', 'gemini', 'nvidia',
]);

// Troncamenti d'elisione italiani («quest'ultimo», «dell'informazione»):
// la parte prima dell'apostrofo è lecita anche se non è una parola completa.
const ELISION_STEMS = new Set([
  'quest', 'quell', 'dell', 'nell', 'sull', 'all', 'dall', 'coll', 'pell',
  'sant', 'anch', 'tutt', 'mezz', 'senz', 'grand', 'buon', 'bell', 'nessun',
  'alcun', 'ciascun', 'quals', 'dov', 'com', 'cos',
]);

/** Crea lo speller combinato IT+EN dalle liste di forme (una per riga). */
export function createSpeller({ itWords, enWords }) {
  const it = new Set(itWords.split('\n').map((w) => w.trim()).filter(Boolean));
  const en = new Set(enWords.split('\n').map((w) => w.trim()).filter(Boolean));
  const known = (w) => {
    const lower = w.toLowerCase();
    return WHITELIST.has(lower) || it.has(lower) || en.has(lower);
  };
  return {
    correct(word) {
      // Elisioni: controlla separatamente le parti attorno all'apostrofo.
      const parts = word.split(/['’]/).filter(Boolean);
      if (parts.length > 1) {
        return parts.every(
          (p, i) =>
            p.length <= 2 ||
            (i < parts.length - 1 && ELISION_STEMS.has(p.toLowerCase())) ||
            known(p),
        );
      }
      if (known(word)) return true;
      // Forme verbali con pronome enclitico spesso assenti dalle liste di
      // frequenza («indicandoli», «suggeritagli», «propostoci»), pur avendo
      // una base perfettamente valida.
      const lower = word.toLowerCase();
      for (const suffix of ['glielo', 'gliela', 'glieli', 'gliele', 'gli', 'mi', 'ti', 'ci', 'vi', 'si', 'lo', 'la', 'li', 'le', 'ne']) {
        if (lower.length > suffix.length + 3 && lower.endsWith(suffix)) {
          const base = lower.slice(0, -suffix.length);
          if (known(base)) return true;
        }
      }
      return false;
    },
  };
}

let spellerPromise = null;

/** Carica (una sola volta) le liste impacchettate e costruisce lo speller. */
export function loadSpeller() {
  if (!spellerPromise) {
    spellerPromise = (async () => {
      let base = '/';
      try {
        base = import.meta.env.BASE_URL || '/';
      } catch {
        /* Node: i test usano direttamente createSpeller */
      }
      const get = async (name) => {
        const res = await fetch(`${base}dict/${name}`);
        if (!res.ok) throw new Error(`Dizionario ${name} non trovato (${res.status}).`);
        return res.text();
      };
      const [itWords, enWords] = await Promise.all([get('it.words'), get('en.words')]);
      return createSpeller({ itWords, enWords });
    })();
    spellerPromise.catch(() => {
      spellerPromise = null; // consenti un nuovo tentativo dopo un errore
    });
  }
  return spellerPromise;
}

/**
 * Estrae la prosa dal codice Typst: via il preambolo (#set/#show/#let),
 * i nomi di funzione, le stringhe tra virgolette e i percorsi.
 */
export function extractProse(typst) {
  return normalizeSoftHyphens(typst)
    .replace(/^#(set|show|let|import)\b[^\n]*$/gm, ' ')
    .replace(/"[^"\n]*"/g, ' ') // stringhe (font, percorsi immagine)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/#[a-zA-Z][\w.-]*/g, ' ') // token funzione (#figure, #block…)
    // Enfasi Typst finita in mezzo a una parola («*M*entre»): per il
    // dizionario è comunque «Mentre», non il falso frammento «entre».
    .replace(/(?<=\p{L})[*_]+(?=\p{L})/gu, '')
    .replace(/<\/?[a-zA-Z][^>]*>/g, ' '); // eventuale HTML residuo
}

/**
 * Scioglie i soft-hyphen OCR U+00AD. Gestisce anche i due artefatti osservati
 * nelle scansioni: prefisso ripetuto («rela­relazione») e suffisso ripetuto
 * («speciale­le»). Il carattere è tipografico e non rappresenta contenuto.
 */
export function normalizeSoftHyphens(source, onChange = null) {
  return String(source || '').replace(
    /(\p{L}+)\u00AD(\p{L}+)/gu,
    (whole, left, right) => {
      const l = left.toLocaleLowerCase('it');
      const r = right.toLocaleLowerCase('it');
      let repaired;
      if (r.startsWith(l)) repaired = withInitialCase(right, left);
      else if (l.endsWith(r)) repaired = left;
      else repaired = left + right;
      onChange?.(whole, repaired);
      return repaired;
    },
  );
}

const WORD_RE = /\p{L}[\p{L}'’]{2,}/gu;
const HYPHENATED_OCR_RE = /(\p{L}{2,})([ \t]*-[ \t]*(?:\n[ \t]*)?)(\p{Ll}{2,})/gu;
const SPACED_FRAGMENT_RE = /(?<!\p{L})(?=(\p{L}{3,6})([ \t]+)(\p{Ll}{3,8})(?!\p{L}))/gu;
const SEMANTIC_SHORT_COMPOUNDS = new Set([
  'nord-est', 'nord-ovest', 'sud-est', 'sud-ovest',
]);
const FUSED_FUNCTION_WORDS = [
  'della', 'delle', 'degli', 'stato', 'che', 'del', 'dei', 'una', 'uno',
];

function withInitialCase(word, model) {
  if (!/^\p{Lu}/u.test(model) || !word) return word;
  return word.charAt(0).toLocaleUpperCase('it') + word.slice(1);
}

/** Proposta deterministica per due frammenti OCR adiacenti. */
export function suggestOcrWordRepair(left, separator, right, speller) {
  if (!left || !right || !speller?.correct) return '';
  const joined = left + right;
  const leftKnown = speller.correct(left);
  const rightKnown = speller.correct(right);
  const hasHyphen = separator.includes('-');
  const hasSpace = /\s/.test(separator);

  if (speller.correct(joined)) {
    // Con un trattino senza spazi conserva i composti plausibili quando le
    // due metà sono entrambe parole («socio-politico»). Negli altri casi la
    // parola unita, confermata dal dizionario, è la lettura più prudente.
    const compound = `${left.toLocaleLowerCase('it')}-${right.toLocaleLowerCase('it')}`;
    if (SEMANTIC_SHORT_COMPOUNDS.has(compound)) return '';
    if (
      !hasHyphen ||
      hasSpace ||
      !leftKnown ||
      !rightKnown ||
      left.length <= 3 ||
      right.length <= 3
    ) return joined;
  }
  if (hasHyphen) {
    const l = left.toLocaleLowerCase('it');
    const r = right.toLocaleLowerCase('it');
    // Frammento duplicato dall'OCR: «mo-modificata» → «modificata».
    if (l.length <= 4 && r.startsWith(l) && rightKnown) return withInitialCase(right, left);
    if (r.length <= 4 && l.endsWith(r) && leftKnown) return left;
  }
  // Senza trattino interviene solo su DUE frammenti entrambi ignoti:
  // «desi gnare» → «designare», evitando «in contro» → «incontro».
  if (!hasHyphen && !leftKnown && !rightKnown && speller.correct(joined)) return joined;
  return '';
}

/** Separa fusioni OCR certe: «contareche» → «contare che». */
export function suggestFusedWordRepair(word, speller) {
  if (!word || !speller?.correct || speller.correct(word)) return '';
  const lower = word.toLocaleLowerCase('it');
  for (const suffix of FUSED_FUNCTION_WORDS) {
    if (!lower.endsWith(suffix) || lower.length <= suffix.length + 2) continue;
    const cut = word.length - suffix.length;
    const left = word.slice(0, cut);
    const right = word.slice(cut);
    if (speller.correct(left) && speller.correct(right)) return `${left} ${right}`;
  }
  return '';
}

/**
 * Trova le parole sospette (ignote a entrambi i dizionari) nel codice Typst.
 * @param {string} typst
 * @param {{correct:(w:string)=>boolean}} speller
 * @param {Set<string>} [ignore] dizionario personale (minuscole): mai segnalate
 * @returns {{word:string,count:number,context:string}[]} ordinate per frequenza
 */
export function findSuspects(typst, speller, ignore = new Set()) {
  const prose = extractProse(typst);
  const seen = new Map(); // parola/span → {count, context, suggestedFix?}
  const covered = [];
  // Lessico interno del documento: fondamentale per nomi propri/editori non
  // presenti nei dizionari, ma già scritti correttamente altrove.
  const observed = new Map();
  for (const m of prose.matchAll(WORD_RE)) {
    const key = m[0].toLocaleLowerCase('it');
    if (!observed.has(key)) observed.set(key, m[0]);
  }
  const add = (word, at, suggestedFix = '') => {
    if (ignore.has(word.toLowerCase())) return;
    const known = seen.get(word);
    if (known) {
      known.count++;
      return;
    }
    const context = prose
      .slice(Math.max(0, at - 45), at + word.length + 45)
      .replace(/\s+/g, ' ')
      .trim();
    seen.set(word, { count: 1, context, suggestedFix });
  };

  // Le sequenze spezzate sono una singola unità da correggere. In questo modo
  // l'AI riceve «comparta-mento», non due richieste isolate e incompatibili.
  for (const m of prose.matchAll(HYPHENATED_OCR_RE)) {
    const at = m.index ?? 0;
    let suggestion = suggestOcrWordRepair(m[1], m[2], m[3], speller);
    if (!suggestion) {
      const joined = m[1] + m[3];
      suggestion = observed.get(joined.toLocaleLowerCase('it')) || '';
    }
    const suspicious = suggestion || !speller.correct(m[1]) || !speller.correct(m[3]);
    if (!suspicious) continue;
    add(m[0], at, suggestion);
    covered.push([at, at + m[0].length]);
  }
  for (const m of prose.matchAll(SPACED_FRAGMENT_RE)) {
    const at = m.index ?? 0;
    const whole = m[1] + m[2] + m[3];
    const suggestion = suggestOcrWordRepair(m[1], m[2], m[3], speller);
    if (!suggestion) continue;
    add(whole, at, suggestion);
    covered.push([at, at + whole.length]);
  }

  for (const m of prose.matchAll(WORD_RE)) {
    const at = m.index ?? 0;
    if (covered.some(([start, end]) => at >= start && at < end)) continue;
    const word = m[0].replace(/['’]$/, '');
    if (word.length < 4) continue;
    if (/^\p{Lu}+$/u.test(word)) continue; // sigle/nomi parlanti in MAIUSCOLO
    if (ignore.has(word.toLowerCase())) continue; // dizionario personale
    if (speller.correct(word)) continue;
    add(word, at, suggestFusedWordRepair(word, speller));
  }
  return [...seen.entries()]
    .map(([word, v]) => ({
      word,
      count: v.count,
      context: v.context,
      ...(v.suggestedFix ? { suggestedFix: v.suggestedFix } : {}),
    }))
    .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word));
}

/**
 * Chiede a un LLM veloce la correzione dei sospetti: SOLO parola + contesto,
 * mai il documento. Il modello lascia stare nomi propri e termini tecnici.
 * Usa il motore/modello della fase Typst (basta un modello leggero).
 * @param {object} p
 * @param {object} p.settings
 * @param {{word:string,context:string}[]} p.entries
 * @param {AbortSignal} [p.signal]
 * @returns {Promise<{word:string,fix:string}[]>} solo le voci da cambiare
 */
export async function requestSpellFixes({ settings, entries, signal }) {
  const system =
    'Sei un correttore di bozze esperto. Il testo proviene dall’OCR di un ' +
    'documento accademico in italiano (con possibili citazioni inglesi). ' +
    'Rispondi SOLTANTO con JSON valido.';
  const user =
    'Per ogni parola o SEQUENZA sospetta (con il suo contesto) indica la correzione del ' +
    'refuso OCR. Se la parola è in realtà corretta (nome proprio, termine ' +
    'tecnico o specialistico, parola straniera, neologismo d’autore), ' +
    'OMETTILA dalla risposta. Correggi solo refusi evidenti: lettere ' +
    'scambiate/mancanti/spurie, accenti sbagliati. Se la voce contiene due ' +
    'frammenti separati da trattino o spazio, correggi l’INTERA sequenza in ' +
    'una sola parola e riporta `word` IDENTICO alla voce ricevuta. Se invece ' +
    'una voce contiene più parole fuse (es. `contareche`), separale nella ' +
    'frase corretta (`contare che`). Non cambiare mai il ' +
    'significato.\n\nVOCI:\n' +
    entries
      .map((e, i) => `${i + 1}. "${e.word}" — contesto: «${e.context}»`)
      .join('\n') +
    '\n\nRispondi SOLO con: {"corrections":[{"word":"…","fix":"…"}]}';

  let text;
  if (settings.typstEngine === 'nvidia') {
    text = await nvidiaChat({
      apiKey: settings.nvidiaApiKey,
      endpoint: settings.nvidiaEndpoint,
      model: settings.nvidiaTypstModel,
      system,
      user,
      temperature: 0.1,
      maxTokens: 4096,
      signal,
    });
  } else {
    text = await geminiGenerate({
      apiKey: settings.googleApiKey,
      model: settings.geminiTypstModel,
      system,
      user,
      temperature: 0.1,
      maxTokens: 4096,
      json: true,
      signal,
    });
  }
  const parsed = extractJson(text);
  const list = Array.isArray(parsed.corrections) ? parsed.corrections : [];
  return list.filter(
    (c) =>
      c &&
      typeof c.word === 'string' &&
      typeof c.fix === 'string' &&
      c.fix.trim() &&
      c.fix !== c.word,
  );
}

/**
 * Valida le proposte dell'LLM con i dizionari: si accetta SOLO una parola
 * singola che i dizionari conoscono, e SOLO tra le parole effettivamente
 * inviate (i modelli a volte «correggono» parole mai chieste — es.
 * block→blocco, che romperebbe #block). L'LLM propone, il dizionario dispone.
 * Le proposte scartate lasciano la parola tra i sospetti.
 * @param {{word:string,fix:string}[]} corrections
 * @param {{correct:(w:string)=>boolean}} speller
 * @param {Set<string>} [allowedWords] parole che erano state inviate al modello
 * @returns {{ok:{word:string,fix:string}[], rejected:{word:string,fix:string}[]}}
 */
export function validateCorrections(
  corrections,
  speller,
  allowedWords = null,
  acceptedFixes = new Set(),
) {
  const normalized = (text) => String(text || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}]/gu, '')
    .toLocaleLowerCase('it');
  const editDistance = (a, b) => {
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const next = [i];
      for (let j = 1; j <= b.length; j++) {
        next[j] = Math.min(
          next[j - 1] + 1,
          prev[j] + 1,
          prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
        );
      }
      prev = next;
    }
    return prev[b.length];
  };
  const ok = [];
  const rejected = [];
  for (const c of corrections || []) {
    const fix = (c.fix || '').trim();
    if (!fix || fix === c.word) {
      rejected.push(c);
      continue;
    }
    if (allowedWords && !allowedWords.has(c.word)) {
      rejected.push(c);
      continue;
    }
    const parts = fix.split(/\s+/).filter(Boolean);
    const observedFix = acceptedFixes.has(fix.toLocaleLowerCase('it'));
    const singleValid = parts.length === 1 && (speller.correct(fix) || observedFix);
    const splitValid =
      parts.length >= 2 &&
      parts.length <= 3 &&
      parts.every((part) => speller.correct(part)) &&
      editDistance(normalized(c.word), normalized(parts.join(''))) <= 2;
    if (!singleValid && !splitValid) {
      rejected.push(c);
      continue;
    }
    ok.push({ word: c.word, fix });
  }
  return { ok, rejected };
}

/**
 * Maschera le zone di CODICE (preambolo, stringhe, token #funzione, math,
 * commenti) con segnaposto, applica `transform` alla sola prosa e ripristina.
 * Impedisce a qualunque sostituzione testuale di toccare la sintassi Typst.
 */
function onProse(source, transform) {
  const masks = [];
  const stash = (s, re) =>
    s.replace(re, (m) => {
      masks.push(m);
      return `${masks.length - 1}`;
    });
  let s = source;
  s = stash(s, /^#(set|show|let|import)\b[^\n]*$/gm);
  s = stash(s, /"[^"\n]*"/g); // stringhe (font, percorsi immagine)
  s = stash(s, /<!--[\s\S]*?-->/g);
  s = stash(s, /\$[^$\n]*\$/g); // matematica inline
  s = stash(s, /#[a-zA-Z][\w.]*/g); // token funzione (#figure, #block…)
  // Nomi di argomento nelle chiamate («inset:», «left:», «caption:»): sono
  // codice anche se non preceduti da #.
  s = stash(s, /(?<=[(,]\s*)[a-zA-Z][\w.-]*(?=\s*:)/g);
  s = transform(s);
  return s.replace(/(\d+)/g, (_, i) => masks[Number(i)]);
}

/**
 * Applica le correzioni come sostituzioni di parola intera (tutte le
 * occorrenze, confini di parola Unicode), SOLO nella prosa: le zone di
 * codice sono mascherate e non possono essere alterate.
 * @param {string} code
 * @param {{word:string,fix:string}[]} corrections
 * @returns {{code:string, applied:{word:string,fix:string,count:number}[]}}
 */
export function applySpellFixes(code, corrections) {
  const applied = [];
  const out = onProse(code, (s) => {
    for (const c of corrections || []) {
      const escaped = c.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`(?<!\\p{L})${escaped}(?!\\p{L})`, 'gu');
      const count = (s.match(re) || []).length;
      if (!count) continue;
      s = s.replace(re, c.fix);
      applied.push({ word: c.word, fix: c.fix, count });
    }
    return s;
  });
  return { code: out, applied };
}

/**
 * Normalizzazione deterministica di spaziature e punteggiatura nella prosa
 * (le zone di codice sono mascherate): niente spazi prima di ,.;:!?, spazio
 * dopo la punteggiatura quando manca, parentesi senza spazi interni,
 * trattini d'inciso con spazio su entrambi i lati, doppi spazi collassati.
 * @param {string} source
 * @returns {{fixed:string, changes:string[]}}
 */
export function fixSpacing(source) {
  const changes = [];
  const fixed = onProse(source, (s) => {
    const apply = (re, to, label) => {
      const n = (s.match(re) || []).length;
      if (!n) return;
      s = s.replace(re, to);
      changes.push(`${n} ${label}`);
    };
    apply(/[ \t]+([,;:!?.])/g, '$1', 'spazi prima della punteggiatura rimossi');
    apply(/([,;])(?=\p{L})/gu, '$1 ', 'spazi dopo virgola/punto e virgola aggiunti');
    apply(/([!?])(?=\p{L})/gu, '$1 ', 'spazi dopo !/? aggiunti');
    // Punto a fine frase: solo minuscola.Maiuscola (non tocca sigle «N.B.»,
    // decimali, nomi file — comunque mascherati se tra virgolette).
    apply(/(\p{Ll})\.(?=\p{Lu})/gu, '$1. ', 'spazi dopo il punto aggiunti');
    apply(/\([ \t]+/g, '(', 'spazi dopo parentesi aperta rimossi');
    apply(/[ \t]+\)/g, ')', 'spazi prima di parentesi chiusa rimossi');
    // Virgolette italiane e tipografiche: lo spazio resta FUORI, mai dentro.
    // Gestisce anche le varianti OCR ASCII <<testo>>.
    apply(/([«“‘]|<<)[ \t\n]+/g, '$1', 'spazi dopo virgolette aperte rimossi');
    apply(/[ \t\n]+([»”’]|>>)/g, '$1', 'spazi prima delle virgolette chiuse rimossi');
    // Trattino d'inciso con spazio da un solo lato → spazio su entrambi
    // (i composti «socio-politico», senza spazi, non vengono toccati).
    apply(/(\p{L})-[ \t]+(?=\p{L})/gu, '$1 - ', 'trattini d’inciso normalizzati');
    apply(/(\p{L})[ \t]+-(?=\p{L})/gu, '$1 - ', 'trattini d’inciso normalizzati');
    // Lineette em/en tra lettere → spazi attorno (i range numerici 1970–80
    // non c'entrano: qui servono lettere su entrambi i lati).
    apply(/(\p{L})([—–])(?=\p{L})/gu, '$1 $2 ', 'lineette spaziate');
    // Doppi spazi a metà riga (l'indentazione a inizio riga resta).
    apply(/(\S)[ \t]{2,}/g, '$1 ', 'spazi doppi collassati');
    return s;
  });
  return { fixed, changes };
}

/**
 * Ripara nel Typst già generato le sillabazioni OCR appiattite («ipo - tesi»),
 * limitandosi alla prosa e accettando solo parole confermate dal dizionario.
 */
export function fixOcrHyphenation(source, speller) {
  const changes = [];
  if (!speller?.correct) {
    return {
      fixed: normalizeSoftHyphens(source, (before, after) => changes.push(`${before}→${after}`)),
      changes,
    };
  }
  const fixed = onProse(source, (s) => {
    const replace = (whole, left, separator, right) => {
      const repair = suggestOcrWordRepair(left, separator, right, speller);
      if (!repair || repair === whole) return whole;
      changes.push(`${whole}→${repair}`);
      return repair;
    };
    let out = normalizeSoftHyphens(s, (before, after) => changes.push(`${before}→${after}`));
    out = out.replace(HYPHENATED_OCR_RE, replace);
    // Secondo passaggio per frammenti senza trattino («desi gnare»).
    const edits = [];
    for (const m of out.matchAll(SPACED_FRAGMENT_RE)) {
      const repair = suggestOcrWordRepair(m[1], m[2], m[3], speller);
      if (!repair) continue;
      const before = m[1] + m[2] + m[3];
      edits.push({ start: m.index ?? 0, end: (m.index ?? 0) + before.length, before, repair });
    }
    let occupiedStart = Infinity;
    for (const edit of edits.sort((a, b) => b.start - a.start)) {
      if (edit.end > occupiedStart) continue;
      out = out.slice(0, edit.start) + edit.repair + out.slice(edit.end);
      occupiedStart = edit.start;
      changes.push(`${edit.before}→${edit.repair}`);
    }
    // Terzo passaggio: parole-funzione fuse, soltanto quando entrambe le parti
    // sono note e la forma unita non lo è.
    out = out.replace(WORD_RE, (word) => {
      const repair = suggestFusedWordRepair(word, speller);
      if (!repair) return word;
      changes.push(`${word}→${repair}`);
      return repair;
    });
    return out;
  });
  return { fixed, changes };
}
