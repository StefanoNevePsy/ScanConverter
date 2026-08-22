const WORD_CHAR = /[\p{L}\p{M}\p{N}]/u;

/** Valida e rifinisce una selezione usando gli offset del testo canonico. */
export function normalizeTextSelection(source, start, end, maxChars = 18000) {
  const text = String(source || '');
  let from = Number(start);
  let to = Number(end);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to > text.length || to <= from) {
    return { ok: false, message: 'Seleziona prima un brano del testo di lavoro.' };
  }
  while (from < to && /\s/u.test(text[from])) from++;
  while (to > from && /\s/u.test(text[to - 1])) to--;
  if (to <= from) return { ok: false, message: 'La selezione contiene soltanto spazi.' };
  if (to - from > maxChars) {
    return {
      ok: false,
      message: `La selezione è troppo lunga (${to - from} caratteri): limita l’intervento a ${maxChars}.`,
    };
  }
  if (
    (from > 0 && WORD_CHAR.test(text[from - 1]) && WORD_CHAR.test(text[from])) ||
    (to < text.length && WORD_CHAR.test(text[to - 1]) && WORD_CHAR.test(text[to]))
  ) {
    return { ok: false, message: 'Estendi la selezione fino ai confini completi delle parole.' };
  }
  return { ok: true, start: from, end: to, text: text.slice(from, to) };
}

export function replaceTextSelection(source, selection, replacement) {
  const text = String(source || '');
  return text.slice(0, selection.start) + replacement + text.slice(selection.end);
}
