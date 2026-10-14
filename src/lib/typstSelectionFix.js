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
