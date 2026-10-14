/*
  Sistemazione del codice Typst SELEZIONATO, con il modello della fase
  «Riparazione Typst».

  Serve per i difetti di impaginazione che compilano ma sono sbagliati: un
  elenco puntato scritto con «•» o «–» invece di «- », un titolo rimasto
  testo, un corsivo con i delimitatori sbilanciati. Il modello vede solo il
  pezzo scelto (più due righe di contesto per capire dove si trova) e deve
  restituire lo stesso testo con la marcatura corretta.

  Guard deterministico: le PAROLE del brano non possono cambiare. Il modello
  sistema la sintassi; se riscrive il contenuto, la proposta viene scartata.
*/

import { engineChat } from './engines.js';
import { unwrapCodeBlock } from './gemini.js';

const SYSTEM =
  'Sei un esperto di Typst (il linguaggio di impaginazione). Ricevi un FRAMMENTO ' +
  'di codice Typst selezionato dall’utente dentro un documento più lungo. ' +
  'Correggi SOLO la marcatura Typst del frammento, non il testo. Regole Typst: ' +
  'elenco puntato = righe che iniziano con «- » (spazio dopo il trattino); ' +
  'elenco numerato = «+ » oppure «1. »; sottolivelli rientrati di due spazi; ' +
  'una riga vuota prima e dopo un elenco; titoli = «= », «== »; corsivo = _testo_; ' +
  'grassetto = *testo*. Simboli come «•», «◦», «▪», «–», «—», «*» o «o» usati come ' +
  'punto elenco vanno sostituiti con «- ». Non aggiungere, togliere, tradurre o ' +
  'correggere parole; non toccare #funzioni, etichette e note se sono già valide. ' +
  'Rispondi SOLO con il frammento corretto, senza spiegazioni e senza ```.';

/** Parole del brano, senza marcatura: quello che il modello non può toccare. */
export function wordsOf(code) {
  return String(code || '')
    .replace(/#[a-zA-Z][\w.-]*/g, ' ') // nomi di funzioni Typst
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) || [];
}

/** True se la proposta conserva esattamente le parole dell'originale. */
export function sameWords(before, after) {
  const a = wordsOf(before);
  const b = wordsOf(after);
  // «o» usato come pallino d'elenco può sparire legittimamente.
  const strip = (list) => list.filter((w) => w !== 'o');
  const x = strip(a);
  const y = strip(b);
  return x.length === y.length && x.every((w, i) => w === y[i]);
}

/**
 * @param {object} p
 * @param {object} p.settings
 * @param {string} p.code        frammento selezionato
 * @param {string} [p.before]    righe che precedono (contesto)
 * @param {string} [p.after]     righe che seguono (contesto)
 * @param {string} [p.request]   cosa non va, detto dall'utente (facoltativo)
 * @param {AbortSignal} [p.signal]
 * @returns {Promise<{ok:boolean, code?:string, message:string}>}
 */
export async function fixTypstSelection({ settings, code, before = '', after = '', request = '', signal }) {
  const fragment = String(code || '');
  if (!fragment.trim()) return { ok: false, message: 'Seleziona prima il codice da sistemare.' };
  if (fragment.length > 12000) {
    return { ok: false, message: 'Selezione troppo lunga: sistemane un pezzo alla volta (max ~12.000 caratteri).' };
  }
  const user = [
    request.trim() ? `PROBLEMA SEGNALATO DALL’UTENTE: ${request.trim()}` : '',
    before.trim() ? `CONTESTO PRIMA (non restituirlo):\n${before}` : '',
    `FRAMMENTO DA CORREGGERE:\n${fragment}`,
    after.trim() ? `CONTESTO DOPO (non restituirlo):\n${after}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const raw = await engineChat({
    settings,
    phase: 'fix',
    system: SYSTEM,
    user,
    temperature: 0,
    maxTokens: Math.min(8192, Math.ceil(fragment.length / 2) + 512),
    signal,
  });
  let fixed = unwrapCodeBlock(String(raw || '')).replace(/^\n+|\s+$/g, '');
  if (!fixed) return { ok: false, message: 'Il modello non ha restituito codice.' };
  // Si conservano gli a-capo finali della selezione originale.
  const trailing = fragment.match(/\s*$/)[0];
  fixed += trailing;
  if (fixed === fragment) return { ok: false, message: 'Il modello non ha trovato niente da cambiare.' };
  if (!sameWords(fragment, fixed)) {
    return {
      ok: false,
      message:
        'Proposta scartata: il modello aveva cambiato anche delle parole, non solo la marcatura. ' +
        'Riprova con una selezione più piccola o descrivi meglio il problema.',
    };
  }
  return { ok: true, code: fixed, message: 'Codice sistemato. «Annulla» lo riporta com’era.' };
}

/*
  CORREZIONE OVUNQUE a partire da un esempio.

  La selezione è un CAMPIONE di marcatura sbagliata. Invece di mandare tutto
  il libro al modello, gli si chiede una REGOLA (espressione regolare +
  sostituzione) che trasformi il campione nella forma giusta; la regola poi
  si applica localmente a tutto il documento, in un istante e senza quota.
  Il guard delle parole vale sul documento intero.
*/

const RULE_SYSTEM =
  'Sei un esperto di Typst e di espressioni regolari JavaScript. L’utente ti ' +
  'mostra un ESEMPIO di marcatura Typst sbagliata presa da un documento lungo: ' +
  'lo stesso errore si ripete altrove. Scrivi UNA regola che lo corregga ovunque. ' +
  'Rispondi SOLO con JSON: {"find": "<regex JavaScript, senza barre>", ' +
  '"replace": "<sostituzione, con $1 $2 per i gruppi>", "explanation": "<una frase in italiano>"}. ' +
  'La regex viene applicata con i flag g e m (^ e $ valgono per riga). ' +
  'Deve essere specifica: colpire solo la marcatura sbagliata, mai il testo normale. ' +
  'La sostituzione non deve aggiungere né togliere parole. Forme corrette Typst: ' +
  'elenco puntato «- voce», numerato «+ voce», sottolivello rientrato di due spazi, ' +
  'titoli «= », «== », corsivo _x_, grassetto *x*.';

function parseRule(raw) {
  const text = String(raw || '').replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  if (typeof json?.find !== 'string' || typeof json?.replace !== 'string' || !json.find) {
    throw new Error('regola incompleta');
  }
  if (json.find.length > 400) throw new Error('regola troppo lunga');
  return { find: json.find, replace: json.replace, explanation: String(json.explanation || '') };
}

/** Applica una regola a un testo. Pura: si prova senza rete. */
export function applyRule(text, rule) {
  const re = new RegExp(rule.find, 'gmu');
  let count = 0;
  const out = String(text).replace(re, (...args) => {
    count++;
    const groups = args.slice(1, -2);
    return rule.replace.replace(/\$(\d)/g, (_, n) => groups[Number(n) - 1] ?? '');
  });
  return { text: out, count };
}

/**
 * @returns {Promise<{ok:boolean, code?:string, count?:number, message:string}>}
 */
export async function fixEverywhereLike({ settings, document, example, request = '', signal }) {
  const sample = String(example || '');
  if (!sample.trim()) return { ok: false, message: 'Seleziona un esempio dell’errore.' };
  const user = [
    request.trim() ? `PROBLEMA SEGNALATO: ${request.trim()}` : '',
    `ESEMPIO SBAGLIATO:\n${sample.slice(0, 3000)}`,
  ].filter(Boolean).join('\n\n');

  let lastError = '';
  // Due tentativi: al secondo il modello sa cosa non andava.
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await engineChat({
      settings,
      phase: 'fix',
      system: RULE_SYSTEM,
      user: lastError ? `${user}\n\nLA REGOLA PRECEDENTE NON ANDAVA: ${lastError}` : user,
      temperature: 0,
      maxTokens: 800,
      json: true,
      signal,
    });
    let rule;
    try {
      rule = parseRule(raw);
      new RegExp(rule.find, 'gmu');
    } catch (e) {
      lastError = `risposta non valida (${e.message})`;
      continue;
    }
    const onSample = applyRule(sample, rule);
    if (!onSample.count || onSample.text === sample) {
      lastError = 'non modifica l’esempio';
      continue;
    }
    const whole = applyRule(document, rule);
    if (!sameWords(document, whole.text)) {
      lastError = 'cambia delle parole del testo, non solo la marcatura';
      continue;
    }
    return {
      ok: true,
      code: whole.text,
      count: whole.count,
      message:
        `Corretti ${whole.count} punti nel documento` +
        (rule.explanation ? ` (${rule.explanation})` : '') +
        '. «Annulla» riporta tutto com’era.',
    };
  }
  return {
    ok: false,
    message: `Non sono riuscito a ricavare una correzione sicura: ${lastError}. Prova con un esempio più piccolo o più tipico.`,
  };
}

/**
 * Sistema la marcatura dell'INTERO documento, a pezzi. Ogni pezzo passa dal
 * guard delle parole: un pezzo scartato resta com'era, gli altri vengono
 * applicati.
 */
export async function fixWholeTypst({ settings, document, onProgress, signal }) {
  const text = String(document || '');
  if (!text.trim()) return { ok: false, message: 'Il documento è vuoto.' };
  // Si taglia sulle righe vuote, così un elenco non finisce spezzato a metà.
  const parts = text.split(/(\n\s*\n)/);
  const chunks = [];
  let buf = '';
  for (const part of parts) {
    if (buf.length + part.length > 5000 && buf.trim()) {
      chunks.push(buf);
      buf = '';
    }
    buf += part;
  }
  if (buf) chunks.push(buf);

  let changed = 0;
  let rejected = 0;
  const out = [];
  for (let i = 0; i < chunks.length; i++) {
    if (signal?.aborted) throw new DOMException('Annullato', 'AbortError');
    onProgress?.(i + 1, chunks.length);
    const chunk = chunks[i];
    // Il preambolo (#set, #show, #let) non è testo da impaginare: si lascia.
    if (!chunk.trim() || !/[\p{L}]{3}/u.test(chunk.replace(/^#.*$/gm, ''))) {
      out.push(chunk);
      continue;
    }
    try {
      const res = await fixTypstSelection({ settings, code: chunk, signal });
      if (res.ok) {
        out.push(res.code);
        changed++;
      } else {
        if (/scartata/.test(res.message)) rejected++;
        out.push(chunk);
      }
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      rejected++;
      out.push(chunk);
    }
  }
  const code = out.join('');
  if (code === text) {
    return { ok: false, message: `Nessuna modifica${rejected ? ` (${rejected} pezzi scartati perché cambiavano parole)` : ''}.` };
  }
  return {
    ok: true,
    code,
    message:
      `Sistemati ${changed} pezzi su ${chunks.length}` +
      (rejected ? `, ${rejected} lasciati com’erano` : '') +
      '. «Annulla» riporta tutto com’era.',
  };
}
