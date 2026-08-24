import { findEditorMatches } from './editorScroll.js';

/*
  Sostituzione che ignora le maiuscole per TROVARE ma le conserva nel
  SOSTITUIRE.

  Correggendo un OCR la stessa parola sbagliata torna scritta in tre modi:
  «perche» nel corpo, «Perche» a inizio frase, «PERCHE» in una testatina o in
  una battuta di dialogo. Chi corregge vuole scrivere la forma giusta una volta
  sola, in minuscolo, e ritrovarla applicata dappertutto con il maiuscolo che
  ogni occorrenza aveva.
*/

/** true se la stringa ha almeno una lettera e sono tutte maiuscole. */
function isAllUpper(text) {
  const letters = text.replace(/[^\p{L}]/gu, '');
  return letters.length > 1 && letters === letters.toLocaleUpperCase('it');
}

/** true se solo la prima lettera è maiuscola: «Perché». */
function isCapitalized(text) {
  const first = text.match(/\p{L}/u);
  if (!first) return false;
  const rest = text.slice(text.indexOf(first[0]) + first[0].length);
  return (
    first[0] === first[0].toLocaleUpperCase('it') &&
    rest.replace(/[^\p{L}]/gu, '') === rest.replace(/[^\p{L}]/gu, '').toLocaleLowerCase('it')
  );
}

/**
 * Applica a `replacement` il taglio di maiuscole di `sample`.
 *
 * Un caso misto («McLuhan», «PhD») non viene reinterpretato: quello che si
 * legge nel campo di sostituzione è quello che finisce nel testo.
 */
export function matchCase(sample, replacement) {
  const source = String(sample || '');
  const target = String(replacement || '');
  if (!target) return target;
  if (isAllUpper(source)) return target.toLocaleUpperCase('it');
  if (isCapitalized(source)) {
    const first = target.match(/\p{L}/u);
    if (!first) return target;
    const at = target.indexOf(first[0]);
    return target.slice(0, at) + first[0].toLocaleUpperCase('it') + target.slice(at + first[0].length);
  }
  return target;
}

/**
 * Sostituisce UNA occorrenza già localizzata, conservandone il caso.
 * @returns {string} il testo completo aggiornato
 */
export function replaceOccurrence(value, start, end, replacement) {
  const text = String(value || '');
  return text.slice(0, start) + matchCase(text.slice(start, end), replacement) + text.slice(end);
}

/**
 * Sostituisce tutte le occorrenze di `query` (senza distinzione di maiuscole),
 * conservando per ciascuna il taglio che aveva.
 *
 * @param {string} value
 * @param {string} query
 * @param {string} replacement
 * @param {{wholeWord?: boolean}} [options]
 * @returns {{value: string, count: number}}
 */
export function replaceAllPreservingCase(value, query, replacement, options = {}) {
  const text = String(value || '');
  const needle = String(query || '');
  if (!needle) return { value: text, count: 0 };
  const positions = findEditorMatches(text, needle, options.wholeWord === true);
  if (!positions.length) return { value: text, count: 0 };
  let out = '';
  let cursor = 0;
  for (const at of positions) {
    out += text.slice(cursor, at) + matchCase(text.slice(at, at + needle.length), replacement);
    cursor = at + needle.length;
  }
  return { value: out + text.slice(cursor), count: positions.length };
}
