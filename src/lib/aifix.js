/*
  Correzione AI degli errori di compilazione Typst, PUNTIFORME.

  A differenza dell'autofix deterministico (typstfix.js), qui l'errore del
  compilatore + il codice vengono dati a un modello forte (di default
  GLM-5.2 via NVIDIA, configurabile: DeepSeek, Gemini, ecc.) che risponde con
  una lista di sostituzioni minime {find, replace} in JSON. Le sostituzioni
  vengono applicate testualmente — con corrispondenza esatta o, solo se
  univoca, tollerante alla spaziatura — MAI l'intero documento riscritto.
  Così il contenuto resta intatto e la modifica è verificabile.
*/

import { engineChat, modelFor } from './engines.js';

export const FIX_SYSTEM =
  'Sei un esperto del linguaggio di impaginazione Typst (versione 0.13). ' +
  'Correggi errori di compilazione con la modifica MINIMA possibile, senza ' +
  'alterare il contenuto testuale del documento. Rispondi SOLTANTO con JSON ' +
  'valido, senza alcun altro testo.';

/** Intervallo e testo da inviare al modello, centrati sulla diagnostica. */
export function repairExcerpt(code, hint, maxChars = 12000) {
  const source = String(code || '');
  if (source.length <= maxChars || !hint?.line) {
    return {
      text: source,
      start: 0,
      end: source.length,
      startLine: 1,
      endLine: source.split('\n').length,
    };
  }
  const lines = source.split('\n');
  const target = Math.max(0, Math.min(lines.length - 1, hint.line - 1));
  let start = target;
  let end = target;
  let size = lines[target].length;
  while (size < maxChars && (start > 0 || end + 1 < lines.length)) {
    if (start > 0) size += lines[--start].length + 1;
    if (size >= maxChars) break;
    if (end + 1 < lines.length) size += lines[++end].length + 1;
  }
  let startOffset = 0;
  for (let i = 0; i < start; i++) startOffset += lines[i].length + 1;
  const text = lines.slice(start, end + 1).join('\n');
  return {
    text,
    start: startOffset,
    end: startOffset + text.length,
    startLine: start + 1,
    endLine: end + 1,
  };
}

/** Compatibilità/test: restituisce soltanto il testo focalizzato. */
export function focusCodeForRepair(code, hint, maxChars = 12000) {
  return repairExcerpt(code, hint, maxChars).text;
}

export function buildFixUser(code, error, hint, excerpt = repairExcerpt(code, hint)) {
  const focusedCode = excerpt.text;
  const excerpted = focusedCode.length < String(code || '').length;
  return (
    'Questo codice Typst NON compila.\n\n' +
    `ERRORE DEL COMPILATORE:\n${error}\n\n` +
    (hint
      ? 'POSIZIONE SEGNALATA DAL COMPILATORE LOCALE: il primo errore è alla ' +
        `riga ${hint.line}${hint.column ? `, colonna ${hint.column}` : ''} e il blocco comincia con: ` +
        `«${hint.snippet}». Concentra la ` +
        'correzione lì (l’errore può però nascere poco prima, es. un ' +
        'delimitatore aperto nel blocco precedente).\n\n'
      : '') +
    (excerpted
      ? `ESTRATTO DEL CODICE, righe originali ${excerpt.startLine}-${excerpt.endLine} ` +
        '(il resto è omesso perché il documento è molto lungo):\n'
      : 'CODICE COMPLETO:\n') +
    '```typst\n' +
    focusedCode +
    '\n```\n\n' +
    'Individua la causa (es. delimitatori non chiusi, parentesi sbilanciate, ' +
    'sintassi LaTeX residua, funzioni inesistenti) e proponi correzioni ' +
    'PUNTIFORMI. Rispondi SOLO con questo JSON:\n' +
    '{"fixes":[{"find":"porzione ESATTA del codice da sostituire (copiala ' +
    'carattere per carattere dal codice, con abbastanza contesto da essere ' +
    'univoca)","replace":"porzione corretta"}],"explanation":"causa in una frase"}\n' +
    'Regole: al massimo 3 fixes; ogni "find" DEVE comparire letteralmente ' +
    'nell’ESTRATTO e deve includere abbastanza contesto da essere univoco ' +
    'all’interno dell’estratto; non riscrivere l’intero documento; non riassumere né eliminare ' +
    'testo del contenuto.'
  );
}

function whitespaceFlexibleMatch(source, find, start = 0, end = source.length) {
  const pieces = find.trim().split(/\s+/).filter(Boolean);
  if (pieces.length < 2) return null;
  const escaped = pieces.map((piece) => piece.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(escaped.join('\\s+'), 'gu');
  const matches = [...source.slice(start, end).matchAll(re)];
  // Mai scegliere arbitrariamente fra più occorrenze: la patch deve restare
  // puntiforme e verificabile.
  return matches.length === 1
    ? { index: start + matches[0].index, length: matches[0][0].length }
    : null;
}

function exactUniqueMatch(source, find, start = 0, end = source.length) {
  const area = source.slice(start, end);
  const first = area.indexOf(find);
  if (first === -1 || area.indexOf(find, first + Math.max(1, find.length)) !== -1) return null;
  return { index: start + first, length: find.length };
}

/**
 * Estrae il primo oggetto JSON bilanciato dalla risposta del modello
 * (tollera recinti ``` e testo attorno).
 */
export function extractJson(text) {
  const t = text
    .trim()
    .replace(/^```(?:json)?\s*\n?/i, '')
    .replace(/\n?```$/i, '');
  const start = t.indexOf('{');
  if (start === -1) throw new Error('La risposta dell’AI non conteneva JSON.');
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return JSON.parse(t.slice(start, i + 1));
    }
  }
  throw new Error('JSON incompleto nella risposta dell’AI.');
}

/**
 * Applica le sostituzioni testuali: prima corrispondenza esatta; altrimenti
 * accetta differenze nella sola spaziatura esclusivamente se l'esito è unico.
 * @param {string} code
 * @param {{find:string,replace:string}[]} fixes
 * @param {{scope?:{start:number,end:number}}} [options]
 * @returns {{code:string, applied:{find:string,replace:string}[], failed:{find:string}[]}}
 */
export function applyFixes(code, fixes, options = {}) {
  let s = code;
  const applied = [];
  const failed = [];
  let scopeStart = Math.max(0, Math.min(s.length, Number(options?.scope?.start ?? 0)));
  let scopeEnd = Math.max(scopeStart, Math.min(s.length, Number(options?.scope?.end ?? s.length)));
  for (const f of fixes || []) {
    if (!f || typeof f.find !== 'string' || typeof f.replace !== 'string' || !f.find) continue;
    if (f.find === f.replace) {
      failed.push({ find: f.find });
      continue;
    }
    let match = exactUniqueMatch(s, f.find, scopeStart, scopeEnd);
    if (!match) {
      const flexible = whitespaceFlexibleMatch(s, f.find, scopeStart, scopeEnd);
      if (!flexible) {
        failed.push({ find: f.find });
        continue;
      }
      match = flexible;
    }
    s = s.slice(0, match.index) + f.replace + s.slice(match.index + match.length);
    scopeEnd += f.replace.length - match.length;
    applied.push(f);
  }
  return { code: s, applied, failed };
}

/**
 * Chiede al modello configurato le correzioni per un errore di compilazione.
 * @param {object} p
 * @param {object} p.settings  impostazioni correnti (chiavi, fixEngine, fixModel)
 * @param {string} p.code      codice Typst che non compila
 * @param {string} p.error     messaggio d'errore (già leggibile)
 * @param {AbortSignal} [p.signal]
 * @returns {Promise<{fixes:Array, explanation:string, scope:object}>}
 */
// Errori transitori (rate limit / servizio saturo) da riprovare con attesa.
const TRANSIENT_RE = /(^|\D)(429|500|503)(\D|$)|rate.?limit|exhausted|overloaded|unavailable/i;

export async function requestTypstFix({ settings, code, error, hint, signal }) {
  let delay = 5000;
  for (let attempt = 0; ; attempt++) {
    try {
      return await requestOnce({ settings, code, error, hint, signal });
    } catch (e) {
      if (signal?.aborted || e?.name === 'AbortError') throw e;
      if (attempt >= 2 || !TRANSIENT_RE.test(e.message || '')) throw e;
      await new Promise((r) => setTimeout(r, delay));
      delay *= 3;
    }
  }
}

async function requestOnce({ settings, code, error, hint, signal }) {
  const engine = settings.fixEngine || 'nvidia';
  // L'estratto centrato sulla diagnostica (invece del documento intero) tiene
  // la richiesta piccola anche su libri: `scope` dice poi ad applyFixes dove
  // può cercare le sostituzioni, così non toccano righe fuori dall'estratto.
  const excerpt = repairExcerpt(code, hint);
  const user = buildFixUser(code, error, hint, excerpt);
  const text = await engineChat({
    settings,
    engine,
    model: modelFor(settings, engine, settings.fixModel),
    system: FIX_SYSTEM,
    user,
    temperature: 0.1,
    maxTokens: 2048,
    json: true,
    signal,
  });
  const parsed = extractJson(text);
  return {
    fixes: Array.isArray(parsed.fixes) ? parsed.fixes : [],
    explanation: typeof parsed.explanation === 'string' ? parsed.explanation : '',
    scope: {
      start: excerpt.start,
      end: excerpt.end,
      startLine: excerpt.startLine,
      endLine: excerpt.endLine,
    },
  };
}

/** Descrizione compatta di una sostituzione, per il riepilogo all'utente. */
export function describeFix(f) {
  const cut = (s) => {
    const one = s.replace(/\s+/g, ' ').trim();
    return one.length > 40 ? one.slice(0, 40) + '…' : one;
  };
  return `«${cut(f.find)}» → «${cut(f.replace) || '(rimosso)'}»`;
}
