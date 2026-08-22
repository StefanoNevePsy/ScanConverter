const LINE_H = 24;

/** Trova sottostringhe o parole intere con confini Unicode. */
export function findEditorMatches(value, query, wholeWord = false, limit = 5000) {
  if (!query) return [];
  const hay = String(value || '').toLocaleLowerCase('it');
  const needle = String(query).toLocaleLowerCase('it');
  const out = [];
  const wordChar = /[\p{L}\p{M}]/u;
  let i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1 && out.length < limit) {
    const before = i > 0 ? hay[i - 1] : '';
    const after = hay[i + needle.length] || '';
    if (!wholeWord || (!wordChar.test(before) && !wordChar.test(after))) out.push(i);
    i += needle.length || 1;
  }
  return out;
}

function clippedExcerpt(value, maxChars = 150) {
  const text = String(value || '').trim();
  if (text.length <= maxChars) return text;
  const prefix = text.slice(0, maxChars + 1);
  const boundary = Math.max(prefix.lastIndexOf('. '), prefix.lastIndexOf(' '));
  return prefix.slice(0, boundary >= 36 ? boundary + (prefix[boundary] === '.' ? 1 : 0) : maxChars).trim();
}

function isPdfSafeLocationText(item) {
  return /^[\p{L}\p{M}\p{N}'’\-\s]+$/u.test(item) && !item.includes('\n');
}

function locationCandidates(value) {
  const raw = String(value || '').trim();
  if (!raw) return [];
  const withoutMetadata = raw
    .replace(/<!--[\s\S]*?-->/gu, ' ')
    .replace(/!\[([^\]]*)\]\([^)]+\)/gu, '$1')
    .replace(/^#{1,6}\s+/gmu, '')
    .replace(/^\s*(?:[-+*]|\d+[.)])\s+/gmu, '')
    .replace(/<\/?[a-z][^>]*>/giu, ' ')
    .replace(/[*_`]/gu, ' ');
  const structuralSegments = raw.split(
    /<!--[\s\S]*?-->|<\/?[a-z][^>]*>|!\[[^\]]*\]\([^)]+\)|[*_`]+/giu,
  );
  const clauses = [raw, withoutMetadata, ...structuralSegments]
    .flatMap((item) => item.split(/[,:;.!?…()\[\]{}]+/gu));
  const variants = [raw, withoutMetadata, ...structuralSegments, ...clauses]
    .flatMap((item) => [item.trim(), item.replace(/\s+/gu, ' ').trim()])
    .filter((item) => /[\p{L}\p{N}]/u.test(item));
  const candidates = [];
  for (const variant of variants) {
    const excerpt = clippedExcerpt(variant);
    if (excerpt) candidates.push(excerpt);
    const firstSentence = variant.match(/^.{12,}?[.!?…](?:\s|$)/u)?.[0]?.trim();
    if (firstSentence) candidates.push(clippedExcerpt(firstSentence));
  }
  return [...new Set(candidates)].sort((left, right) => (
    Number(isPdfSafeLocationText(right)) - Number(isPdfSafeLocationText(left)) || right.length - left.length
  ));
}

/** Trova nel Typst il miglior frammento visibile di un avviso o suggerimento. */
export function findBestEditorLocation(editorCode, sourceText, approximateRatio = 0) {
  const source = String(editorCode || '');
  const ratio = Math.max(0, Math.min(1, Number(approximateRatio) || 0));
  for (const query of locationCandidates(sourceText)) {
    const matches = findEditorMatches(source, query, isPdfSafeLocationText(query));
    if (!matches.length) continue;
    let occurrence = 0;
    let distance = Infinity;
    for (let index = 0; index < matches.length; index++) {
      const current = Math.abs(matches[index] / Math.max(1, source.length) - ratio);
      if (current < distance) {
        distance = current;
        occurrence = index;
      }
    }
    return {
      query,
      occurrence,
      start: matches[occurrence],
      end: matches[occurrence] + query.length,
    };
  }
  return null;
}

/** Porta un offset testuale al centro anche quando una singola riga sorgente
 * occupa molte righe VISIVE nel textarea per effetto del wrapping. */
export function scrollTextareaOffsetIntoView(editor, value, offset) {
  if (!editor || typeof document === 'undefined') return;
  const computed = window.getComputedStyle(editor);
  const mirror = document.createElement('div');
  const copied = [
    'fontFamily', 'fontSize', 'fontStyle', 'fontWeight', 'lineHeight',
    'letterSpacing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'textTransform', 'wordBreak', 'overflowWrap', 'tabSize',
  ];
  for (const property of copied) mirror.style[property] = computed[property];
  Object.assign(mirror.style, {
    position: 'fixed',
    visibility: 'hidden',
    pointerEvents: 'none',
    left: '-10000px',
    top: '0',
    width: `${editor.clientWidth}px`,
    height: 'auto',
    boxSizing: 'border-box',
    whiteSpace: 'pre-wrap',
  });
  mirror.append(document.createTextNode(value.slice(0, offset)));
  const marker = document.createElement('span');
  marker.textContent = value.slice(offset, offset + 1) || '\u200b';
  mirror.append(marker);
  document.body.append(mirror);
  editor.scrollTop = Math.max(0, marker.offsetTop - editor.clientHeight / 2 + LINE_H / 2);
  mirror.remove();
}
