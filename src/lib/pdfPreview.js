/** Normalizzazione condivisa fra il testo cercato nell'editor e PDF.js. */
export function normalizePdfSearchText(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('it');
}

/** Conta le occorrenze non sovrapposte di una stringa già normalizzabile. */
export function countPdfTextOccurrences(value, query) {
  const text = normalizePdfSearchText(value);
  const needle = normalizePdfSearchText(query);
  if (!text || !needle) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += Math.max(1, needle.length);
  }
  return count;
}

/**
 * Sceglie la pagina che contiene l'occorrenza richiesta. Se la numerazione
 * nel sorgente Typst non coincide perfettamente con il layer PDF (preambolo,
 * sillabazione), ricade sulla prima pagina che contiene comunque il testo.
 */
export function choosePdfSearchPage(pageMatchCounts, occurrence = 0) {
  const wanted = Math.max(0, Number.isInteger(occurrence) ? occurrence : 0);
  let seen = 0;
  let first = -1;
  for (let i = 0; i < pageMatchCounts.length; i++) {
    const matches = Math.max(0, Number(pageMatchCounts[i]) || 0);
    if (!matches) continue;
    if (first === -1) first = i;
    if (wanted < seen + matches) return i;
    seen += matches;
  }
  return first;
}

/** Converte la selezione dell'editor in una ricerca leggera nel PDF. */
export function createPdfSearchTarget(source, match) {
  const text = String(source || '');
  const start = match?.start;
  const end = match?.end;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > text.length) {
    return null;
  }
  const selected = text.slice(start, end);
  // Stesso guardrail della vecchia evidenziazione Typst: soltanto testo
  // visibile, mai sintassi o selezioni multilinea.
  if (!/^[\p{L}\p{M}\p{N}'’\-\s]+$/u.test(selected) || selected.includes('\n')) return null;

  const normalized = normalizePdfSearchText(selected);
  if (!normalized) return null;
  const occurrence = countPdfTextOccurrences(text.slice(0, start), selected);
  return { id: match.id, text: selected, normalized, occurrence };
}
