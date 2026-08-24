import { findEditorMatches } from './editorScroll.js';

/*
  Coda di revisione: le parole sospette messe in ORDINE DI DOCUMENTO.

  Il controllo ortografico produce un elenco per frequenza, comodo per decidere
  in blocco («Bateson» è un nome, non segnalarlo più) ma pessimo per la
  correzione vera: si salta dalla pagina 200 alla 3 e ritorno. Qui le stesse
  parole diventano una sequenza di FERMATE nel testo, dalla prima all'ultima,
  così la revisione scorre in avanti una volta sola.

  La posizione, non l'indice, è il riferimento: dopo una correzione il testo si
  accorcia o si allunga e le fermate cambiano numero. Chi usa questo modulo
  conserva l'offset della fermata corrente e ricalcola l'indice con
  `stopIndexAtOrAfter`, così un'operazione a metà documento non riporta la
  revisione all'inizio.
*/

const MAX_STOPS = 2000;
const CONTEXT_RADIUS = 52;

/** Una parola singola si cerca a parola intera; uno span OCR («compor- tamento») no. */
function wantsWholeWord(word) {
  return /^[\p{L}\p{M}'’]+$/u.test(word);
}

/** Estratto attorno alla fermata, preso dal Typst ATTUALE e non dal report. */
export function stopContext(value, start, end, radius = CONTEXT_RADIUS) {
  const text = String(value || '');
  const before = text.slice(Math.max(0, start - radius), start).replace(/\s+/gu, ' ');
  const after = text.slice(end, end + radius).replace(/\s+/gu, ' ');
  return {
    before: (start > radius ? '…' : '') + before.replace(/^\s+/u, ''),
    word: text.slice(start, end).replace(/\s+/gu, ' '),
    after: after.replace(/\s+$/u, '') + (end + radius < text.length ? '…' : ''),
  };
}

/**
 * Costruisce le fermate di revisione per il testo corrente.
 *
 * @param {string} value    codice Typst nell'editor
 * @param {{word:string, count?:number, context?:string, suggestedFix?:string}[]} suspects
 * @param {{skip?:Set<string>, limit?:number}} [options] parole già archiviate dall'utente
 * @returns {{word:string,start:number,end:number,line:number,occurrence:number,
 *            suggestedFix:string, before:string, after:string}[]}
 */
export function buildReviewStops(value, suspects, options = {}) {
  const text = String(value || '');
  const skip = options.skip || new Set();
  const limit = options.limit || MAX_STOPS;
  const found = [];
  for (const suspect of suspects || []) {
    const word = suspect?.word;
    if (!word || skip.has(word)) continue;
    const positions = findEditorMatches(text, word, wantsWholeWord(word), limit);
    positions.forEach((start, occurrence) => {
      found.push({
        word,
        start,
        end: start + word.length,
        occurrence,
        suggestedFix: suspect.suggestedFix || '',
      });
    });
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);

  // Uno span OCR può contenere una parola a sua volta sospetta: una sola
  // fermata, quella più esterna, altrimenti l'utente rivede due volte lo
  // stesso punto e la seconda volta il testo non c'è più.
  const stops = [];
  let reach = -1;
  for (const stop of found) {
    if (stop.start < reach) continue;
    reach = stop.end;
    stops.push(stop);
    if (stops.length >= limit) break;
  }

  // Numeri di riga in una sola passata: `split` su tutto il documento a ogni
  // fermata costerebbe O(n²) su un libro.
  let line = 1;
  let cursor = 0;
  for (const stop of stops) {
    for (let i = cursor; i < stop.start; i++) if (text[i] === '\n') line++;
    cursor = stop.start;
    stop.line = line;
    Object.assign(stop, stopContext(text, stop.start, stop.end));
  }
  return stops;
}

/**
 * Prima fermata che comincia a `offset` o dopo.
 *
 * È il modo di ritrovare il proprio posto dopo una modifica: se la fermata
 * corrente è sparita (corretta, ignorata, riscritta) si continua da quella
 * successiva, non da capo.
 */
export function stopIndexAtOrAfter(stops, offset) {
  if (!stops?.length) return -1;
  const target = Number(offset) || 0;
  let low = 0;
  let high = stops.length - 1;
  let answer = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (stops[mid].start >= target) {
      answer = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  // Oltre l'ultima fermata si resta sull'ultima: la revisione è finita, non
  // ricomincia da sola dall'inizio del documento.
  return answer === -1 ? stops.length - 1 : answer;
}

/** Fermata successiva/precedente, con giro completo. */
export function stepStop(stops, index, delta) {
  if (!stops?.length) return -1;
  const n = stops.length;
  return ((index + delta) % n + n) % n;
}

/**
 * Righe da segnare nel margine dell'editor, con quante fermate ciascuna.
 *
 * Una riga con tre sospetti merita un solo puntino: il margine indica dove
 * guardare, il conteggio sta nel titolo del puntino.
 */
export function stopLines(stops) {
  const lines = new Map();
  for (const stop of stops || []) {
    const found = lines.get(stop.line);
    if (found) found.count++;
    else lines.set(stop.line, { line: stop.line, start: stop.start, count: 1 });
  }
  return [...lines.values()].sort((a, b) => a.line - b.line);
}
