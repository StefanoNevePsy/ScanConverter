/*
  Workflow ad alta fedeltà.

  Il corpo del documento non viene rigenerato da un LLM: il Markdown OCR è
  convertito in Typst con regole deterministiche. In questo modo ogni modifica
  testuale può provenire soltanto da una patch di correzione esplicita.
*/

import { buildPreamble, extractTitle } from './preamble.js';

/** Testo confrontabile, Unicode-aware, con numeri e ordine preservati. */
export function canonicalTokens(text) {
  return (text || '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase('it')
    .match(/[\p{L}\p{N}]+/gu) || [];
}

/**
 * Allineamento monotono LCS: localizza parole eliminate, aggiunte e ordine
 * alterato. È più severo del controllo a trigrammi e mantiene le occorrenze
 * duplicate distinte.
 */
export function compareTokenSequences(source, output, maxDetails = 20) {
  const a = canonicalTokens(source);
  const b = canonicalTokens(output);
  // Evita matrici enormi: il confronto per chunk resta normalmente piccolo.
  // Per input eccezionali usa una scansione monotona conservativa.
  if (a.length * b.length > 4_000_000) {
    let j = 0;
    const missing = [];
    for (const token of a) {
      while (j < b.length && b[j] !== token) j++;
      if (j < b.length) j++;
      else if (missing.length < maxDetails) missing.push(token);
    }
    return {
      ok: missing.length === 0 && a.length === b.length,
      sourceCount: a.length,
      outputCount: b.length,
      matched: a.length - missing.length,
      missing,
      added: b.length > a.length ? [`${b.length - a.length} parole aggiunte`] : [],
    };
  }

  const rows = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      rows[i][j] = a[i] === b[j]
        ? rows[i + 1][j + 1] + 1
        : Math.max(rows[i + 1][j], rows[i][j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  const missing = [];
  const added = [];
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (rows[i + 1][j] >= rows[i][j + 1]) {
      if (missing.length < maxDetails) missing.push(a[i]);
      i++;
    } else {
      if (added.length < maxDetails) added.push(b[j]);
      j++;
    }
  }
  while (i < a.length) {
    if (missing.length < maxDetails) missing.push(a[i]);
    i++;
  }
  while (j < b.length) {
    if (added.length < maxDetails) added.push(b[j]);
    j++;
  }
  const matched = rows[0][0];
  return {
    ok: matched === a.length && matched === b.length,
    sourceCount: a.length,
    outputCount: b.length,
    matched,
    missing,
    added,
  };
}

function escapePlain(s) {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/([#$@\[\]])/g, '\\$1')
    .replace(/</g, '\\<')
    .replace(/>/g, '\\>');
}

/** Converte enfasi/codice Markdown senza consentire l'esecuzione di Typst. */
export function inlineMarkdownToTypst(text) {
  const slots = [];
  const hold = (rendered) => {
    const key = `\uE000${slots.length}\uE001`;
    slots.push(rendered);
    return key;
  };
  let s = String(text || '');
  s = s.replace(/<sup>([\s\S]*?)<\/sup>/gi, (_, x) => hold(`#super[${escapePlain(x)}]`));
  s = s.replace(/`([^`]+)`/g, (_, x) =>
    hold(`#raw("${x.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}")`));
  s = s.replace(/\*\*([^*]+)\*\*/g, (_, x) => hold(`*${escapePlain(x)}*`));
  s = s.replace(/_([^_\n]+)_/g, (_, x) => hold(`_${escapePlain(x)}_`));
  s = s.replace(/\*([^*\n]+)\*/g, (_, x) => hold(`_${escapePlain(x)}_`));
  s = escapePlain(s);
  return s.replace(/\uE000(\d+)\uE001/g, (_, n) => slots[Number(n)] || '');
}

function figureBlock(block) {
  const m = block.trim().match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
  if (!m) return null;
  const caption = inlineMarkdownToTypst(m[1]);
  const path = m[2].replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return caption
    // Evita #figure con caption: Typst aggiungerebbe automaticamente
    // "Figura N", testo che non appartiene alla fonte canonica.
    ? `#block[\n#align(center)[#image("${path}", width: 80%)]\n#align(center)[#text(size: 9pt, style: "italic")[${caption}]]\n]`
    : `#block[#align(center)[#image("${path}", width: 80%)]]`;
}

function markdownTable(block) {
  const lines = block.trim().split('\n').filter(Boolean);
  if (lines.length < 2 || !lines.every((l) => l.includes('|'))) return null;
  const cells = (l) => l.replace(/^\s*\||\|\s*$/g, '').split('|').map((x) => x.trim());
  if (!cells(lines[1]).every((c) => /^:?-{3,}:?$/.test(c))) return null;
  const head = cells(lines[0]);
  const rows = lines.slice(2).map(cells);
  const rendered = [
    ...head.map((c) => `[*${inlineMarkdownToTypst(c)}*]`),
    ...rows.flatMap((r) => Array.from({ length: head.length }, (_, i) =>
      `[${inlineMarkdownToTypst(r[i] || '')}]`)),
  ];
  return `#table(columns: ${head.length}, ${rendered.join(', ')})`;
}

function unwrapLatexCell(cell) {
  return cell
    .replace(/\\multicolumn\{\d+\}\{[^}]*\}\{([\s\S]*)\}/g, '$1')
    .replace(/\\(?:textbf|textit|emph)\{([^{}]*)\}/g, '$1')
    .replace(/\\(?:hline|toprule|midrule|bottomrule)\b/g, '')
    .trim();
}

/** Conversione prudente delle tabelle tabular prodotte da Nemotron. */
function latexTable(block) {
  const m = block.match(/\\begin\{tabular\}\{([^}]*)\}([\s\S]*?)\\end\{tabular\}/);
  if (!m) return null;
  const rows = m[2]
    .replace(/\\(?:hline|toprule|midrule|bottomrule)\b/g, '')
    .split(/\\\\(?:\[[^\]]*\])?/) // fine riga LaTeX: \\
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => r.split('&').map(unwrapLatexCell));
  if (!rows.length) return null;
  const columns = Math.max(
    rows.reduce((n, r) => Math.max(n, r.length), 0),
    (m[1].match(/[lcrX]|p\{[^}]*\}/g) || []).length,
    1,
  );
  const rendered = rows.flatMap((r) =>
    Array.from({ length: columns }, (_, i) => `[${inlineMarkdownToTypst(r[i] || '')}]`));
  return `#table(columns: ${columns}, ${rendered.join(', ')})`;
}

/** Converte un documento Markdown OCR in corpo Typst deterministico. */
export function markdownToStrictTypst(markdown) {
  const blocks = String(markdown || '').trim().split(/\n{2,}/);
  const out = [];
  for (const original of blocks) {
    let block = original.trim();
    if (!block) continue;
    const leadingPage = block.match(/^<!--\s*pagina\s+(\d+)\s*-->\s*/i);
    if (leadingPage) {
      out.push(`// pagina ${leadingPage[1]}`);
      block = block.slice(leadingPage[0].length).trim();
      if (!block) continue;
    }
    const page = block.match(/^<!--\s*pagina\s+(\d+)\s*-->$/i);
    if (page) {
      out.push(`// pagina ${page[1]}`);
      continue;
    }
    const fig = figureBlock(block);
    if (fig) {
      out.push(fig);
      continue;
    }
    const latex = latexTable(block);
    if (latex) {
      out.push(latex);
      continue;
    }
    const table = markdownTable(block);
    if (table) {
      out.push(table);
      continue;
    }
    const heading = block.match(/^(#{1,6})\s+([\s\S]+)$/);
    if (heading && !heading[2].includes('\n')) {
      out.push(`${'='.repeat(heading[1].length)} ${inlineMarkdownToTypst(heading[2])}`);
      continue;
    }
    const lines = block.split('\n');
    if (lines.every((l) => /^\s*[-*+]\s+/.test(l))) {
      out.push(lines.map((l) => `- ${inlineMarkdownToTypst(l.replace(/^\s*[-*+]\s+/, ''))}`).join('\n'));
      continue;
    }
    if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) {
      out.push(lines.map((l) => `+ ${inlineMarkdownToTypst(l.replace(/^\s*\d+[.)]\s+/, ''))}`).join('\n'));
      continue;
    }
    out.push(lines.map(inlineMarkdownToTypst).join('\n'));
  }
  return out.join('\n\n');
}

/** Estrae il testo canonico dal Markdown, escludendo solo metadati e path. */
export function sourcePlainText(markdown) {
  return String(markdown || '')
    .replace(/<!--[^>]*-->/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, ' $1 ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/<\/?sup>/gi, '')
    .replace(/\\begin\{tabular\}\{[^}]*\}|\\end\{tabular\}/g, ' ')
    .replace(/\\(?:hline|toprule|midrule|bottomrule)\b/g, ' ')
    .replace(/\\multicolumn\{\d+\}\{[^}]*\}\{([^{}]*)\}/g, ' $1 ')
    .replace(/\\(?:textbf|textit|emph)\{([^{}]*)\}/g, ' $1 ')
    .replace(/&|\\\\/g, ' ')
    .replace(/[*_`]/g, ' ')
    .replace(/^\s*(?:[-+*]|\d+[.)])\s+/gm, '')
    .replace(/^\s*\|?\s*:?-{3,}:?(?:\s*\|\s*:?-{3,}:?)+\s*\|?\s*$/gm, ' ')
    .replace(/\|/g, ' ');
}

/** Crea un documento completo usando il preambolo locale predefinito. */
export function buildStrictDocument(markdown) {
  const body = markdownToStrictTypst(markdown);
  const preamble = buildPreamble({}, { title: extractTitle(body) });
  return { preamble, body, sourceText: sourcePlainText(markdown) };
}

/** Invarianti fragili che devono ricomparire esattamente. */
export function extractInvariants(text) {
  const s = String(text || '');
  const patterns = [
    /\b\d+(?:[.,]\d+)?\s*%/g,
    /\b\d+(?:[.,]\d+)?\b/g,
    /\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+\b/gi,
    /https?:\/\/[^\s)\]]+/gi,
  ];
  return patterns.flatMap((re) => s.match(re) || []);
}

export function missingInvariants(source, output) {
  const available = [...extractInvariants(output)];
  const missing = [];
  for (const item of extractInvariants(source)) {
    const i = available.indexOf(item);
    if (i === -1) missing.push(item);
    else available.splice(i, 1);
  }
  return missing;
}
