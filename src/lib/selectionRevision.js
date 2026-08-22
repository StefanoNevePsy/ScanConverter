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

function exactPositions(source, needle) {
  if (!needle) return [];
  const positions = [];
  let cursor = 0;
  while (cursor <= source.length - needle.length) {
    const index = source.indexOf(needle, cursor);
    if (index < 0) break;
    positions.push(index);
    cursor = index + Math.max(1, needle.length);
  }
  return positions;
}

function closestRelativePosition(positions, sourceLength, ratio) {
  return positions
    .map((position) => ({
      position,
      distance: Math.abs(position / Math.max(1, sourceLength) - ratio),
    }))
    .sort((left, right) => left.distance - right.distance)[0]?.position;
}

/**
 * Riporta una selezione fatta nel textarea Typst al testo canonico. Il caso
 * comune (prosa e markup inline) è byte-per-byte; gli escape aggiunti dal
 * renderer vengono rimossi in un secondo tentativo. Se l'utente include
 * comandi Typst o testo generato dal preambolo, la funzione fallisce chiusa.
 */
export function mapEditorSelectionToCanonical({
  canonical,
  editorCode,
  start,
  end,
  maxChars = 18000,
}) {
  const editorSelection = normalizeTextSelection(editorCode, start, end, maxChars);
  if (!editorSelection.ok) {
    return {
      ...editorSelection,
      message: editorSelection.message.replace('testo di lavoro', 'codice Typst'),
    };
  }
  if (/^\s*#(?:set|show|let|import|include)\b/mu.test(editorSelection.text)) {
    return {
      ok: false,
      message: 'La selezione include comandi Typst: evidenzia soltanto il testo visibile da correggere o tradurre.',
    };
  }

  const candidates = [
    editorSelection.text,
    editorSelection.text.replace(/\\([#$@\[\]<>\\])/gu, '$1'),
  ].filter((value, index, all) => value && all.indexOf(value) === index);
  const editorRatio = editorSelection.start / Math.max(1, String(editorCode || '').length);
  for (const candidate of candidates) {
    const canonicalPositions = exactPositions(String(canonical || ''), candidate).filter((position) => (
      normalizeTextSelection(canonical, position, position + candidate.length, maxChars).ok
    ));
    if (!canonicalPositions.length) continue;
    let position = canonicalPositions[0];
    if (canonicalPositions.length > 1) {
      const editorPositions = exactPositions(String(editorCode || ''), editorSelection.text);
      const ordinal = editorPositions.indexOf(editorSelection.start);
      position = ordinal >= 0 && editorPositions.length === canonicalPositions.length
        ? canonicalPositions[ordinal]
        : closestRelativePosition(canonicalPositions, String(canonical || '').length, editorRatio);
    }
    const normalized = normalizeTextSelection(
      canonical,
      position,
      position + candidate.length,
      maxChars,
    );
    if (normalized.ok) return { ...normalized, source: 'typst' };
  }
  return {
    ok: false,
    message:
      'Il testo selezionato non è riconducibile in modo sicuro alla fonte canonica. ' +
      'Seleziona soltanto le parole visibili, senza comandi o parentesi Typst.',
  };
}
