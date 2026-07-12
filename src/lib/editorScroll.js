const LINE_H = 24;

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
