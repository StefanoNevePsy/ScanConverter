// Colore volutamente specifico: PdfPreview lo usa per ritrovare nel grande
// SVG la sola occorrenza evidenziata e centrarla nel pannello di anteprima.
export const SEARCH_HIGHLIGHT_COLOR = '#ffde59';

/**
 * Crea un sorgente Typst effimero con una sola occorrenza evidenziata.
 * Accetta esclusivamente testo semplice: se la selezione tocca sintassi Typst
 * restituisce il sorgente invariato, evitando di rompere l'anteprima.
 */
export function markTypstSearchMatch(source, start, end) {
  const text = String(source || '');
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > text.length) {
    return text;
  }
  const selected = text.slice(start, end);
  if (!/^[\p{L}\p{M}\p{N}'’\-\s]+$/u.test(selected) || selected.includes('\n')) return text;
  const marked = `#highlight(fill: rgb("${SEARCH_HIGHLIGHT_COLOR}"))[${selected}]`;
  return text.slice(0, start) + marked + text.slice(end);
}
