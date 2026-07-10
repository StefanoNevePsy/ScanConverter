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
      return known(word);
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
  return typst
    .replace(/^#(set|show|let|import)\b[^\n]*$/gm, ' ')
    .replace(/"[^"\n]*"/g, ' ') // stringhe (font, percorsi immagine)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/#[a-zA-Z][\w.-]*/g, ' ') // token funzione (#figure, #block…)
    .replace(/<\/?[a-zA-Z][^>]*>/g, ' '); // eventuale HTML residuo
}

const WORD_RE = /\p{L}[\p{L}'’]{2,}/gu;

/**
 * Trova le parole sospette (ignote a entrambi i dizionari) nel codice Typst.
 * @param {string} typst
 * @param {{correct:(w:string)=>boolean}} speller
 * @returns {{word:string,count:number,context:string}[]} ordinate per frequenza
 */
export function findSuspects(typst, speller) {
  const prose = extractProse(typst);
  const seen = new Map(); // parola (forma originale) → {count, context}
  for (const m of prose.matchAll(WORD_RE)) {
    const word = m[0].replace(/['’]$/, '');
    if (word.length < 4) continue;
    if (/^\p{Lu}+$/u.test(word)) continue; // sigle/nomi parlanti in MAIUSCOLO
    const known = seen.get(word);
    if (known) {
      known.count++;
      continue;
    }
    if (speller.correct(word)) continue;
    const at = m.index ?? 0;
    const context = prose
      .slice(Math.max(0, at - 45), at + word.length + 45)
      .replace(/\s+/g, ' ')
      .trim();
    seen.set(word, { count: 1, context });
  }
  return [...seen.entries()]
    .map(([word, v]) => ({ word, count: v.count, context: v.context }))
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
    'Per ogni parola sospetta (con il suo contesto) indica la correzione del ' +
    'refuso OCR. Se la parola è in realtà corretta (nome proprio, termine ' +
    'tecnico o specialistico, parola straniera, neologismo d’autore), ' +
    'OMETTILA dalla risposta. Correggi solo refusi evidenti: lettere ' +
    'scambiate/mancanti/spurie, accenti sbagliati. Non cambiare mai il ' +
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
      model: settings.geminiModel,
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
 * singola che i dizionari conoscono. Blocca deterministicamente le
 * allucinazioni dei modelli deboli (nomi espansi, «correzioni» inventate):
 * l'LLM propone, il dizionario dispone. Le proposte scartate lasciano la
 * parola tra i sospetti, correggibile a mano.
 * @param {{word:string,fix:string}[]} corrections
 * @param {{correct:(w:string)=>boolean}} speller
 * @returns {{ok:{word:string,fix:string}[], rejected:{word:string,fix:string}[]}}
 */
export function validateCorrections(corrections, speller) {
  const ok = [];
  const rejected = [];
  for (const c of corrections || []) {
    const fix = (c.fix || '').trim();
    if (!fix || /\s/.test(fix) || fix === c.word) {
      rejected.push(c);
      continue;
    }
    if (!speller.correct(fix)) {
      rejected.push(c);
      continue;
    }
    ok.push({ word: c.word, fix });
  }
  return { ok, rejected };
}

/**
 * Applica le correzioni come sostituzioni di parola intera (tutte le
 * occorrenze, confini di parola Unicode).
 * @param {string} code
 * @param {{word:string,fix:string}[]} corrections
 * @returns {{code:string, applied:{word:string,fix:string,count:number}[]}}
 */
export function applySpellFixes(code, corrections) {
  let s = code;
  const applied = [];
  for (const c of corrections || []) {
    const escaped = c.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?<!\\p{L})${escaped}(?!\\p{L})`, 'gu');
    const count = (s.match(re) || []).length;
    if (!count) continue;
    s = s.replace(re, c.fix);
    applied.push({ word: c.word, fix: c.fix, count });
  }
  return { code: s, applied };
}
