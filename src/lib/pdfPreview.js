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

/*
  Anteprima che segue il cursore.

  Il PDF non sa da quale riga del sorgente viene ogni pagina, e chiederglielo
  costerebbe rileggere il testo di tutte le pagine. Ma un libro è testo
  continuo: la posizione del cursore nel sorgente dice, con buona
  approssimazione, a che punto del PDF si è. Si salta subito lì — costo zero —
  e poi si conferma cercando la riga del cursore in un pugno di pagine
  attorno, invece che nelle quattrocento del libro.
*/

/** Pagina stimata (1-based) da quanto si è avanti nel sorgente. */
export function estimatePdfPage(ratio, pageCount) {
  const pages = Math.max(0, Math.floor(Number(pageCount) || 0));
  if (!pages) return 0;
  const clamped = Math.min(1, Math.max(0, Number(ratio) || 0));
  return Math.min(pages, Math.max(1, Math.round(clamped * (pages - 1)) + 1));
}

/**
 * Pagine da guardare, dalla stima verso l'esterno: prima quella stimata, poi
 * la successiva e la precedente, e così via.
 * @returns {number[]} numeri di pagina 1-based
 */
export function pageSearchOrder(estimate, pageCount, radius = 4) {
  const pages = Math.max(0, Math.floor(Number(pageCount) || 0));
  if (!pages) return [];
  const start = Math.min(pages, Math.max(1, Math.round(Number(estimate) || 1)));
  const order = [start];
  for (let step = 1; step <= radius; step++) {
    if (start + step <= pages) order.push(start + step);
    if (start - step >= 1) order.push(start - step);
  }
  return order;
}

/**
 * Frammento del sorgente attorno al cursore da cercare nel PDF.
 *
 * Serve una riga di prosa vera: la sintassi Typst nel PDF non c'è, e cercarla
 * porterebbe solo a non trovare niente.
 */
export function cursorSearchText(source, offset, maxChars = 60) {
  const text = String(source || '');
  const at = Math.min(Math.max(0, Number(offset) || 0), text.length);
  const from = text.lastIndexOf('\n', Math.max(0, at - 1)) + 1;
  let to = text.indexOf('\n', at);
  if (to === -1) to = text.length;
  const line = text.slice(from, to).trim();
  if (!line || /^[=#/<]/u.test(line)) return '';
  // Solo parole: niente marcatura, niente numeri di riga, niente parentesi.
  const words = line
    .replace(/[*_`\[\]#]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (words.length < 12) return '';
  return words.slice(0, maxChars).trim();
}
