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

import { nvidiaChat } from './nvidia.js';
import { geminiGenerate } from './gemini.js';

export const FIX_SYSTEM =
  'Sei un esperto del linguaggio di impaginazione Typst (versione 0.13). ' +
  'Correggi errori di compilazione con la modifica MINIMA possibile, senza ' +
  'alterare il contenuto testuale del documento. Rispondi SOLTANTO con JSON ' +
  'valido, senza alcun altro testo.';

/** Costruisce il messaggio utente con errore + codice (+ posizione, se nota). */
export function focusCodeForRepair(code, hint, maxChars = 30000) {
  const source = String(code || '');
  if (source.length <= maxChars || !hint?.line) return source;
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
  return lines.slice(start, end + 1).join('\n');
}

export function buildFixUser(code, error, hint) {
  const focusedCode = focusCodeForRepair(code, hint);
  const excerpted = focusedCode.length < String(code || '').length;
  return (
    'Questo codice Typst NON compila.\n\n' +
    `ERRORE DEL COMPILATORE:\n${error}\n\n` +
    (hint
      ? 'POSIZIONE INDIZIATA (trovata per bisezione con il compilatore ' +
        `locale): il primo blocco che fa fallire la compilazione inizia alla ` +
        `riga ${hint.line} e comincia con: «${hint.snippet}». Concentra la ` +
        'correzione lì (l’errore può però nascere poco prima, es. un ' +
        'delimitatore aperto nel blocco precedente).\n\n'
      : '') +
    (excerpted
      ? 'ESTRATTO DEL CODICE ATTORNO ALL’ERRORE (il resto è omesso perché il documento è molto lungo):\n'
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
    'Regole: al massimo 5 fixes; ogni "find" DEVE comparire letteralmente nel ' +
    'codice; non riscrivere l’intero documento; non riassumere né eliminare ' +
    'testo del contenuto.'
  );
}

function whitespaceFlexibleMatch(source, find) {
  const pieces = find.trim().split(/\s+/).filter(Boolean);
  if (pieces.length < 2) return null;
  const escaped = pieces.map((piece) => piece.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(escaped.join('\\s+'), 'gu');
  const matches = [...source.matchAll(re)];
  // Mai scegliere arbitrariamente fra più occorrenze: la patch deve restare
  // puntiforme e verificabile.
  return matches.length === 1
    ? { index: matches[0].index, length: matches[0][0].length }
    : null;
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
 * @returns {{code:string, applied:{find:string,replace:string}[], failed:{find:string}[]}}
 */
export function applyFixes(code, fixes) {
  let s = code;
  const applied = [];
  const failed = [];
  for (const f of fixes || []) {
    if (!f || typeof f.find !== 'string' || typeof f.replace !== 'string' || !f.find) continue;
    if (f.find === f.replace) {
      failed.push({ find: f.find });
      continue;
    }
    let idx = s.indexOf(f.find);
    let length = f.find.length;
    if (idx === -1) {
      const flexible = whitespaceFlexibleMatch(s, f.find);
      if (!flexible) {
        failed.push({ find: f.find });
        continue;
      }
      idx = flexible.index;
      length = flexible.length;
    }
    s = s.slice(0, idx) + f.replace + s.slice(idx + length);
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
 * @returns {Promise<{fixes:Array, explanation:string}>}
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
  const user = buildFixUser(code, error, hint);
  let text;
  if (engine === 'gemini') {
    text = await geminiGenerate({
      apiKey: settings.googleApiKey,
      model: settings.fixModel || settings.geminiTypstModel,
      system: FIX_SYSTEM,
      user,
      temperature: 0.1,
      maxTokens: 4096,
      json: true,
      signal,
    });
  } else {
    text = await nvidiaChat({
      apiKey: settings.nvidiaApiKey,
      endpoint: settings.nvidiaEndpoint,
      model: settings.fixModel || 'z-ai/glm-5.2',
      system: FIX_SYSTEM,
      user,
      temperature: 0.1,
      maxTokens: 4096,
      signal,
    });
  }
  const parsed = extractJson(text);
  return {
    fixes: Array.isArray(parsed.fixes) ? parsed.fixes : [],
    explanation: typeof parsed.explanation === 'string' ? parsed.explanation : '',
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
