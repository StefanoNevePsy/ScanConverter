/* Normalizzazione pura delle diagnostiche Typst, testabile senza WASM. */

/**
 * Converte un intervallo in coordinate 1-based per l'editor. Le diagnostiche
 * `full` seguono LSP (0-based); le stringhe `unix` sono già 1-based.
 */
export function parseTypstRange(range, zeroBased = true) {
  const match = String(range || '').match(/^(\d+):(\d+)(?:-(\d+):(\d+))?$/);
  if (!match) return null;
  const shift = zeroBased ? 1 : 0;
  return {
    start: { line: Number(match[1]) + shift, column: Number(match[2]) + shift },
    end: {
      line: Number(match[3] || match[1]) + shift,
      column: Number(match[4] || match[2]) + shift,
    },
  };
}

/** Normalizza diagnostiche full/unix e i vecchi errori Rust-debug. */
export function normalizeTypstDiagnostics(value) {
  const input = Array.isArray(value) ? value : value == null ? [] : [value];
  const diagnostics = [];
  for (const item of input) {
    if (item && typeof item === 'object') {
      const rangeText = typeof item.range === 'string' ? item.range : '';
      const range = parseTypstRange(rangeText);
      diagnostics.push({
        severity: String(item.severity || 'error').toLowerCase(),
        message: String(item.message || '').trim(),
        path: String(item.path || ''),
        range: rangeText,
        line: range?.start.line || null,
        column: range?.start.column || null,
        endLine: range?.end.line || null,
        endColumn: range?.end.column || null,
      });
      continue;
    }
    const text = String(item || '');
    const unix = text.match(/^(.*?):(\d+:\d+(?:-\d+:\d+)?):\s*(error|warning|hint):\s*([\s\S]*)$/i);
    if (unix) {
      const range = parseTypstRange(unix[2], false);
      diagnostics.push({
        severity: unix[3].toLowerCase(),
        message: unix[4].trim(),
        path: unix[1],
        range: unix[2],
        line: range?.start.line || null,
        column: range?.start.column || null,
        endLine: range?.end.line || null,
        endColumn: range?.end.column || null,
      });
      continue;
    }
    for (const match of text.matchAll(/message:\s*"((?:[^"\\]|\\.)*)"/g)) {
      diagnostics.push({
        severity: 'error',
        message: match[1].replace(/\\"/g, '"').replace(/\\n/g, ' ').trim(),
        path: '',
        range: '',
        line: null,
        column: null,
        endLine: null,
        endColumn: null,
      });
    }
  }
  return diagnostics.filter((diag) => diag.message);
}

export function formatTypstDiagnostics(diagnostics) {
  const useful = (diagnostics || []).filter((diag) => diag.severity !== 'warning');
  if (!useful.length) return '';
  return useful.slice(0, 4).map((diag) => {
    const where = diag.line
      ? ` (riga ${diag.line}${diag.column ? `, colonna ${diag.column}` : ''})`
      : '';
    return `${diag.message}${where}`;
  }).join(' · ');
}
