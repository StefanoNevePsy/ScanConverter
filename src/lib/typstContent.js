/*
  Lettura conservativa del contenuto visibile di un sorgente Typst.

  Non prova a sostituire il compilatore: individua soltanto i blocchi che
  l'utente può vedere e modificare nell'editor, mantenendo gli offset esatti.
  Serve ai controlli locali (lingua, duplicati e verifica PDF), che dopo la
  generazione devono osservare il Typst corrente e non una copia OCR ormai
  potenzialmente diversa.
*/

const PAGE_MARKER_RE = /^\s*\/\/\s*pagina\s+(\d+)\s*$/gimu;
const CONTROL_BLOCK_RE = /^\s*#(?:set|show|let|import|include)\b/iu;
const NON_TEXT_BLOCK_RE = /^\s*#(?:pagebreak|linebreak|colbreak|v|h)\s*\([^\n]*\)\s*$/iu;

function stripCodeArguments(value) {
  return String(value || '')
    // Risorse e destinazioni non sono testo stampato.
    .replace(/#(?:image|bibliography|include)\s*\(\s*"(?:\\.|[^"\\])*"[\s\S]*?\)/giu, ' ')
    .replace(/#link\s*\(\s*"(?:\\.|[^"\\])*"[^)]*\)/giu, ' ')
    .replace(/\bcaption\s*:\s*\[/giu, '[')
    // Opzioni comuni dei costrutti generati deterministicamente. Il contenuto
    // tra parentesi quadre resta invece disponibile al controllo.
    .replace(/\b(?:columns|rows|width|height|inset|outset|gutter|align|stroke|fill|radius|breakable|kind|numbering|supplement|spacing|weight|size|font|lang|style|top|bottom|left|right)\s*:\s*(?:"(?:\\.|[^"\\])*"|[^,\]\n)]+)/giu, ' ');
}

/** Testo approssimativamente visibile, senza dichiarazioni e token Typst. */
export function typstVisibleText(value) {
  let text = String(value || '');
  if (!text.trim() || CONTROL_BLOCK_RE.test(text.trimStart())) return '';
  text = text
    .replace(/^\s*\/\/.*$/gmu, ' ')
    .replace(/\/\*[\s\S]*?\*\//gu, ' ')
    .replace(/\$([^$\n]*)\$/gu, ' $1 ')
    .replace(/<[^>\n]+>/gu, ' ');
  text = stripCodeArguments(text)
    .replace(/#[a-zA-Z][\w.-]*/gu, ' ')
    .replace(/\(\s*(?:,\s*)*\)/gu, ' ')
    .replace(/^\s*=+\s+/gmu, '')
    .replace(/^\s*(?:[-+]\s+|\d+[.)]\s+)/gmu, '')
    .replace(/\\([#$@\[\]<>\\])/gu, '$1')
    .replace(/[\[\]_*`]/gu, ' ')
    .replace(/[{}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return text;
}

function classifyTypstPassage(text) {
  const first = String(text || '').trimStart();
  if (/^=+\s/u.test(first)) return 'heading';
  if (/^#(?:figure|image)\b/u.test(first)) return 'figure';
  if (/^#(?:table|grid)\b/u.test(first)) return 'table';
  if (/^(?:[-+]\s+|\d+[.)]\s+)/u.test(first)) return 'list';
  return 'prose';
}

function contentRange(source, start, end, kind) {
  if (kind !== 'heading') return { start, end };
  const raw = source.slice(start, end);
  const prefix = raw.match(/^\s*=+\s+/u)?.[0].length || 0;
  return { start: start + prefix, end };
}

/**
 * Blocchi visibili con offset nel sorgente Typst e numero di pagina ricavato
 * dai commenti `// pagina N` emessi dal renderer rigoroso.
 */
export function typstDocumentPassages(typst) {
  const source = String(typst || '');
  const markers = [...source.matchAll(PAGE_MARKER_RE)];
  const regions = markers.length
    ? markers.map((marker, index) => ({
        page: Number(marker[1]),
        start: marker.index + marker[0].length,
        end: index + 1 < markers.length ? markers[index + 1].index : source.length,
      }))
    : [{ page: null, start: 0, end: source.length }];
  const passages = [];
  for (const region of regions) {
    const regionText = source.slice(region.start, region.end);
    const pieces = regionText.split(/(\n{2,})/u);
    let offset = region.start;
    let pageIndex = 0;
    for (const piece of pieces) {
      if (/^\n{2,}$/u.test(piece)) {
        offset += piece.length;
        continue;
      }
      const leading = piece.match(/^\s*/u)?.[0].length || 0;
      const trailing = piece.match(/\s*$/u)?.[0].length || 0;
      const rawStart = offset + leading;
      const rawEnd = offset + Math.max(leading, piece.length - trailing);
      offset += piece.length;
      if (rawEnd <= rawStart) continue;
      const raw = source.slice(rawStart, rawEnd);
      if (CONTROL_BLOCK_RE.test(raw) || NON_TEXT_BLOCK_RE.test(raw)) continue;
      const kind = classifyTypstPassage(raw);
      const range = contentRange(source, rawStart, rawEnd, kind);
      const text = source.slice(range.start, range.end);
      const visibleText = typstVisibleText(text);
      if (!/\p{L}{2,}/u.test(visibleText)) continue;
      passages.push({
        id: `typst-p${region.page ?? 0}-b${pageIndex++}-${range.start}`,
        page: region.page,
        text,
        visibleText,
        start: range.start,
        end: range.end,
        kind,
        translate: kind !== 'figure' && kind !== 'table',
        sourceFormat: 'typst',
      });
    }
  }
  return passages;
}

/** Testo atteso nel PDF, derivato esclusivamente dal Typst aperto. */
export function typstPlainText(typst) {
  return typstDocumentPassages(typst)
    .map((passage) => passage.visibleText)
    .filter(Boolean)
    .join('\n\n');
}
