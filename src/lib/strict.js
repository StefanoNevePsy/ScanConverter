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
    // Ricompone la sillabazione tipografica introdotta a fine riga nel PDF
    // («neces- sario»), che non è una modifica del contenuto.
    .replace(/(\p{L})-\s+(\p{L})/gu, '$1$2')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase('it')
    .match(/[\p{L}\p{N}]+/gu) || [];
}

/** Confronto a multinsieme: robusto all'ordine di estrazione di tabelle/note. */
export function compareTokenInventory(source, output, maxDetails = 20) {
  const count = (tokens) => {
    const map = new Map();
    for (const token of tokens) map.set(token, (map.get(token) || 0) + 1);
    return map;
  };
  const a = count(canonicalTokens(source));
  const b = count(canonicalTokens(output));
  const missing = [];
  const added = [];
  for (const [token, n] of a) {
    const delta = n - (b.get(token) || 0);
    for (let i = 0; i < delta && missing.length < maxDetails; i++) missing.push(token);
  }
  for (const [token, n] of b) {
    const delta = n - (a.get(token) || 0);
    for (let i = 0; i < delta && added.length < maxDetails; i++) added.push(token);
  }
  return { ok: !missing.length && !added.length, missing, added };
}

function comparisonUnits(text) {
  return String(text || '')
    .split(/(?<=[.!?…])\s+|\n{2,}/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => canonicalTokens(s).length);
}

function wordSpans(text) {
  // Il contenuto delle note è semanticamente fuori dal flusso principale e
  // non deve diventare la parola di confine della pagina. Mantieni però la
  // stessa lunghezza per conservare gli indici nel testo originale.
  const visible = String(text || '').replace(
    /<footnote>[\s\S]*?<\/footnote>/gi,
    (note) => ' '.repeat(note.length),
  );
  return [...visible.matchAll(/\p{L}[\p{L}\p{M}'’]*/gu)].map((m) => ({
    raw: m[0],
    normalized: canonicalTokens(m[0])[0] || '',
    index: m.index || 0,
  }));
}

function proseBoundaryBlock(raw) {
  let content = String(raw || '').trim();
  let marker = '';
  const page = content.match(/^<!--\s*pagina\s+(\d+)\s*-->\s*/i);
  if (page) {
    marker = `<!-- pagina ${page[1]} -->`;
    content = content.slice(page[0].length).trim();
  }
  const special =
    !content ||
    /^#{1,6}\s/.test(content) ||
    /^!\[/.test(content) ||
    /\\begin\{tabular\}|^\s*\|/m.test(content) ||
    /^\s*(?:[-+*]|\d+[.)])\s+/m.test(content);
  return { marker, content, prose: !special };
}

const ARABIC_PAGE_NUMBER_ONLY_RE = /^(?:pagina\s+)?\d{1,3}$/i;
const ROMAN_PAGE_NUMBER_ONLY_RE = /^(?:PAGINA\s+)?[IVXLCDM]{1,10}$/;
const isPageNumberOnly = (text) =>
  ARABIC_PAGE_NUMBER_ONLY_RE.test(text) || ROMAN_PAGE_NUMBER_ONLY_RE.test(text);

function isRunningHeaderText(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  const words = t.match(/[\p{L}\p{N}]+/gu) || [];
  return t.length >= 4 && t.length <= 110 && words.length >= 2 && words.length <= 12 && !/[,.!?;:]/u.test(t);
}

function refreshBoundaryRecord(record) {
  const content = record.content.trim();
  record.content = content;
  record.prose = !!content &&
    !/^#{1,6}\s/.test(content) &&
    !/^!\[/.test(content) &&
    !/\\begin\{tabular\}|^\s*\|/m.test(content) &&
    !/^\s*(?:[-+*]|\d+[.)])\s+/m.test(content);
}

/**
 * Rimuove coppie testatina+numero immediatamente dopo un marcatore pagina.
 * È volutamente più severo del filtro bbox: senza coordinate interviene solo
 * quando i due segnali compaiono insieme, anche sulla stessa riga/blocco.
 */
function discardLeadingPageFurniture(records, changes) {
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record.marker) continue;

    const lines = record.content.split('\n').map((line) => line.trim()).filter(Boolean);
    if (lines.length >= 2) {
      const headerFirst = isRunningHeaderText(lines[0]) && isPageNumberOnly(lines[1]);
      const numberFirst = isPageNumberOnly(lines[0]) && isRunningHeaderText(lines[1]);
      if (headerFirst || numberFirst) {
        const header = headerFirst ? lines[0] : lines[1];
        const number = headerFirst ? lines[1] : lines[0];
        changes.push({ type: 'running_header_furniture', before: header, after: '', overlap: '' });
        changes.push({ type: 'page_number_furniture', before: number, after: '', overlap: '' });
        record.content = lines.slice(2).join('\n');
        refreshBoundaryRecord(record);
      }
    }

    // Testatina e numero incollati: «Ipotizzazione … Neutralità 11».
    const combined = record.content.match(/^(.{4,110}?)\s+(\d{1,3}|[IVXLCDM]{1,10})$/);
    if (combined && isRunningHeaderText(combined[1]) && isPageNumberOnly(combined[2])) {
      changes.push({ type: 'running_header_furniture', before: combined[1], after: '', overlap: '' });
      changes.push({ type: 'page_number_furniture', before: combined[2], after: '', overlap: '' });
      record.content = '';
      refreshBoundaryRecord(record);
    }

    // Blocchi separati: marker+testatina, poi numero (o viceversa).
    const next = records[i + 1];
    if (next) {
      const headerThenNumber = isRunningHeaderText(record.content) && isPageNumberOnly(next.content);
      const numberThenHeader = isPageNumberOnly(record.content) && isRunningHeaderText(next.content);
      if (headerThenNumber || numberThenHeader) {
        const header = headerThenNumber ? record.content : next.content;
        const number = headerThenNumber ? next.content : record.content;
        changes.push({ type: 'running_header_furniture', before: header, after: '', overlap: '' });
        changes.push({ type: 'page_number_furniture', before: number, after: '', overlap: '' });
        record.content = '';
        refreshBoundaryRecord(record);
        records.splice(i + 1, 1);
      }
    }
  }
}

function attachEmptyPageMarkers(records) {
  for (let i = 0; i + 1 < records.length; i++) {
    const record = records[i];
    if (!record.marker || record.content) continue;
    if (!records[i + 1].marker) records[i + 1].marker = record.marker;
    records.splice(i, 1);
    i--;
  }
}

/** Elimina numeri di pagina OCR isolati esattamente attorno a un confine. */
function discardBoundaryPageNumbers(records, changes) {
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!isPageNumberOnly(record.content.trim())) continue;
    const besideBoundary = !!record.marker || !!records[i + 1]?.marker || (!!records[i - 1]?.marker && !records[i - 1]?.content);
    if (!besideBoundary) continue;
    changes.push({
      type: 'page_number_furniture',
      before: record.content.trim(),
      after: '',
      overlap: '',
    });
    if (record.marker) {
      record.content = '';
      record.prose = false;
    } else {
      records.splice(i, 1);
      i--;
    }
  }

  for (let i = 0; i < records.length; i++) {
    const right = records[i];
    if (!right.marker) continue;
    const left = records[i - 1];
    if (left?.content) {
      // Numero su una riga propria in coda alla pagina precedente.
      const trailing = left.content.match(/\n\s*([^\n]+?)\s*$/);
      if (trailing && isPageNumberOnly(trailing[1])) {
        changes.push({ type: 'page_number_furniture', before: trailing[1], after: '', overlap: '' });
        left.content = left.content.slice(0, trailing.index).trimEnd();
      }
    }

    // Alcuni OCR incollano «19 devate…» nello stesso blocco. Lo scarto è
    // sicuro solo se la frase precedente era chiaramente ancora aperta e il
    // testo dopo il numero riparte in minuscolo.
    const openLeft = !!left?.content && !/[.!?…»”\])}]\s*$/u.test(left.content);
    const leading = right.content.match(/^\s*(\d{1,3})\s+(?=\p{Ll})/u);
    if (openLeft && leading) {
      changes.push({ type: 'page_number_furniture', before: leading[1], after: '', overlap: '' });
      right.content = right.content.slice(leading[0].length).trimStart();
    }
  }
}

/**
 * Ripara sovrapposizioni OCR tra blocchi/pagine, ad esempio
 * «…cercando.\n\ncercando il punto nodale» → «…cercando il punto nodale».
 * Interviene solo se la ripartenza è minuscola (forte segnale di continuazione)
 * o se coincidono almeno tre parole consecutive.
 */
export function repairBoundaryOverlaps(markdown, maxOverlap = 10, isKnownWord = null) {
  const records = String(markdown || '').trim().split(/\n{2,}/).map(proseBoundaryBlock);
  const changes = [];
  // Sillabazioni tipografiche DENTRO la stessa pagina/blocco OCR. Il trattino
  // viene tolto solo se il dizionario conferma la parola ricomposta.
  if (isKnownWord) {
    for (const record of records) {
      if (!record.prose) continue;
      const joinKnownHyphenation = (whole, left, right) => {
          const joined = left + right;
          if (!isKnownWord(joined)) return whole;
          changes.push({
            type: 'line_word_split',
            before: whole,
            after: joined,
            overlap: '',
          });
          return joined;
        };
      record.content = record.content.replace(
        /(\p{L}{2,})[ \t]*-[ \t]*\n[ \t]*(\p{Ll}{2,})/gu,
        joinKnownHyphenation,
      );
      // Alcuni OCR appiattiscono l'a-capo e lasciano «ipo - tesi» sulla
      // stessa riga. Gli spazi su entrambi i lati distinguono questo caso dai
      // normali composti; il dizionario resta il guardrail decisivo.
      record.content = record.content.replace(
        /(\p{L}{2,})[ \t]+-[ \t]+(\p{Ll}{2,})/gu,
        joinKnownHyphenation,
      );
      refreshBoundaryRecord(record);
    }
  }
  discardLeadingPageFurniture(records, changes);
  discardBoundaryPageNumbers(records, changes);
  attachEmptyPageMarkers(records);
  for (let i = 0; i + 1 < records.length; i++) {
    const left = records[i];
    const right = records[i + 1];
    if (!left.prose || !right.prose) continue;
    const a = wordSpans(left.content);
    const b = wordSpans(right.content);
    if (!a.length || !b.length) continue;
    const leftWord = a[a.length - 1];
    const rightWord = b[0];
    const pageBoundary = !!right.marker;
    const firstVisible = right.content.replace(/^[_*`"“‘«([{\s]+/u, '').charAt(0);
    const lowerContinuation = !!firstVisible && firstVisible === firstVisible.toLocaleLowerCase('it') && firstVisible !== firstVisible.toLocaleUpperCase('it');

    // Una parola tagliata dalla scansione può essere ricostruita dall'OCR in
    // tre modi diversi al cambio pagina:
    //   cercando | cando  → il frammento destro è ripetuto
    //   cer      | cercando → il frammento sinistro è ripetuto
    //   cer      | cando  → i due frammenti vanno concatenati
    // I primi due casi sono strutturali; il terzo viene accettato solo quando
    // il dizionario riconosce la parola unita e non entrambi i frammenti.
    if (pageBoundary && lowerContinuation) {
      const leftNorm = leftWord.normalized;
      const rightNorm = rightWord.normalized;
      const minFragment = 3;
      let mergedWord = '';
      let leftCut = leftWord.index;
      let rightCut = rightWord.index + rightWord.raw.length;

      if (
        rightNorm.length >= minFragment &&
        leftNorm.length > rightNorm.length &&
        leftNorm.endsWith(rightNorm)
      ) {
        mergedWord = leftWord.raw;
        leftCut += leftWord.raw.length;
      } else if (
        leftNorm.length >= minFragment &&
        rightNorm.length > leftNorm.length &&
        rightNorm.startsWith(leftNorm)
      ) {
        mergedWord = rightWord.raw;
      } else if (typeof isKnownWord === 'function') {
        const joined = `${leftWord.raw}${rightWord.raw}`;
        const joinedKnown = isKnownWord(joined);
        const fragmentsKnown = isKnownWord(leftWord.raw) && isKnownWord(rightWord.raw);
        if (joinedKnown && !fragmentsKnown) mergedWord = joined;
      }

      if (mergedWord) {
        const leftBase = left.content.slice(0, leftCut).replace(/[\s,;:.!?…—–-]+$/u, '').trimEnd();
        const rightRest = right.content.slice(rightCut).trimStart();
        // Se conserviamo la parola sinistra, il marcatore viene dopo di essa;
        // se la ricostruiamo, spostiamo l'intera parola nella pagina destra.
        const keptLeftWord = leftCut > leftWord.index;
        const prefix = keptLeftWord ? leftBase : left.content.slice(0, leftWord.index).trimEnd();
        const afterMarker = [keptLeftWord ? '' : mergedWord, rightRest].filter(Boolean).join(' ');
        const merged = [prefix, right.marker, afterMarker].filter(Boolean).join('\n').trim();
        changes.push({
          type: 'boundary_word_split',
          before: `${leftWord.raw} ⟂ ${rightWord.raw}`,
          after: mergedWord,
          overlap: rightWord.raw,
        });
        left.content = merged;
        records.splice(i + 1, 1);
        i--;
        continue;
      }
    }

    let overlap = 0;
    const limit = Math.min(maxOverlap, a.length, b.length);
    for (let n = 1; n <= limit; n++) {
      const suffix = a.slice(-n).map((w) => w.normalized).join(' ');
      const prefix = b.slice(0, n).map((w) => w.normalized).join(' ');
      if (suffix === prefix) overlap = n;
    }
    if (!overlap) continue;
    if (!lowerContinuation && overlap < 3) continue;

    const cut = a[a.length - overlap].index;
    const removed = left.content.slice(cut).trim();
    const leftBase = left.content.slice(0, cut).replace(/[\s,;:—–-]+$/u, '').trimEnd();
    const bridge = right.marker ? `\n${right.marker}\n` : ' ';
    const merged = leftBase
      ? `${leftBase}${bridge}${right.content}`.trim()
      : [right.marker, right.content].filter(Boolean).join('\n');
    changes.push({
      type: 'boundary_overlap',
      before: `${removed} ⟂ ${right.content.slice(0, 160)}`,
      after: merged.slice(Math.max(0, leftBase.length - 80), leftBase.length + 240),
      overlap: a.slice(-overlap).map((w) => w.raw).join(' '),
    });
    left.content = merged;
    // Il marcatore della pagina destra è già stato inserito nel blocco unito.
    // Rimuove il record assorbito e rivaluta lo stesso confine contro il
    // successivo, così funzionano anche tre frammenti OCR sovrapposti.
    records.splice(i + 1, 1);
    i--;
    continue;
  }

  // Anche quando nessuna parola è spezzata, un paragrafo può proseguire
  // oltre il cambio pagina. Mantiene il marcatore ma elimina il paragrafo
  // artificiale se a sinistra non c'è una chiusura di frase e la pagina
  // successiva riparte in minuscolo.
  for (let i = 0; i + 1 < records.length; i++) {
    const left = records[i];
    const right = records[i + 1];
    if (!left.prose || !right.prose || !right.marker) continue;
    const firstVisible = right.content.replace(/^[_*`"“‘«([{\s]+/u, '').charAt(0);
    const lowerContinuation = !!firstVisible && firstVisible === firstVisible.toLocaleLowerCase('it') && firstVisible !== firstVisible.toLocaleUpperCase('it');
    if (!lowerContinuation || /[.!?…»”\])}]\s*$/u.test(left.content)) continue;
    const merged = `${left.content.trimEnd()}\n${right.marker}\n${right.content.trimStart()}`;
    changes.push({
      type: 'boundary_paragraph_continuation',
      before: `${left.content.slice(-80)} ⟂ ${right.content.slice(0, 120)}`,
      after: merged.slice(-240),
      overlap: '',
    });
    left.content = merged;
    records.splice(i + 1, 1);
    i--;
  }
  const text = records
    .filter((r) => r.marker || r.content)
    .map((r) => [r.marker, r.content].filter(Boolean).join('\n'))
    .join('\n\n');
  return { text, changes };
}

/**
 * Raggruppa i token mancanti nella frase sorgente e trova automaticamente il
 * passaggio PDF/Typst con la maggiore sovrapposizione lessicale.
 */
export function buildDifferenceContexts(source, output, missingTokens, maxIssues = 12) {
  const missingCounts = new Map();
  for (const token of missingTokens || []) {
    missingCounts.set(token, (missingCounts.get(token) || 0) + 1);
  }
  const sourceUnits = comparisonUnits(source);
  const outputUnits = comparisonUnits(output);
  const issues = [];
  for (const sentence of sourceUnits) {
    const sourceSet = new Set(canonicalTokens(sentence));
    let best = '';
    let bestScore = -1;
    for (const candidate of outputUnits) {
      const candidateSet = new Set(canonicalTokens(candidate));
      let common = 0;
      for (const token of sourceSet) if (candidateSet.has(token)) common++;
      const score = common / Math.max(sourceSet.size, candidateSet.size, 1);
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
    // Attribuisce un token comune («a», «e», «nel»…) alla frase corretta:
    // deve mancare sia globalmente sia dal miglior passaggio corrispondente.
    const candidateMissing = compareTokenInventory(sentence, best, 100).missing;
    const local = [];
    for (const token of candidateMissing) {
      if ((missingCounts.get(token) || 0) <= 0) continue;
      local.push(token);
      missingCounts.set(token, (missingCounts.get(token) || 0) - 1);
    }
    if (!local.length) continue;
    issues.push({
      id: `diff-${issues.length + 1}`,
      key: JSON.stringify([sentence, local]),
      missing: local,
      source: sentence.slice(0, 600),
      rendered: best.slice(0, 600),
      similarity: Math.max(0, bestScore),
    });
    if (issues.length >= maxIssues) break;
  }
  return issues;
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

const SUPERSCRIPT_DIGITS = new Map([
  ['⁰', '0'], ['¹', '1'], ['²', '2'], ['³', '3'], ['⁴', '4'],
  ['⁵', '5'], ['⁶', '6'], ['⁷', '7'], ['⁸', '8'], ['⁹', '9'],
]);

/** Converte enfasi/codice Markdown senza consentire l'esecuzione di Typst. */
export function inlineMarkdownToTypst(text) {
  const slots = [];
  const hold = (rendered) => {
    const key = `\uE000${slots.length}\uE001`;
    slots.push(rendered);
    return key;
  };
  let s = String(text || '');
  s = s.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]+/gu, (digits) =>
    hold(`#super[${[...digits].map((digit) => SUPERSCRIPT_DIGITS.get(digit)).join('')}]`));
  s = s.replace(/<footnote>([\s\S]*?)<\/footnote>/gi, (_, x) =>
    hold(`#footnote[${inlineMarkdownToTypst(x)}]`));
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
/*
  ------------------------------------------------ elenchi con corpo dentro

  Il caso che rompe tutto è comunissimo nella saggistica: un elenco numerato
  in cui ogni voce è seguita da una spiegazione e da un esempio — spesso una
  trascrizione di seduta con più interlocutori. Fra una voce e l'altra ci sono
  quindi paragrafi, e in Markdown quei paragrafi CHIUDONO l'elenco.

  Ne seguivano due difetti insieme: la numerazione ripartiva da 1 a ogni voce
  (cinque voci tutte «1.»), e il corpo della voce finiva a margine sinistro,
  indistinguibile dal testo corrente.

  Un blocco compreso fra due voci dello stesso elenco appartiene alla prima:
  questo è certo, non è un'euristica. Incerto è solo dove finisca l'ULTIMA
  voce, che nessun blocco successivo delimita — lì si prosegue finché le righe
  sono battute di dialogo, e si smette al primo paragrafo di prosa.
*/

/**
 * Marcatore usato dall'autore per le voci numerate: «1.» oppure «1)».
 *
 * Serve perché Typst riconosce un elenco SOLO dalla forma `1.` — verificato:
 * `1) testo` resta testo normale, senza rientro di continuazione e senza
 * numerazione. Convertendo però si perderebbe la parentesi dell'autore, che
 * in saggistica italiana è la forma più comune. La si recupera nel preambolo
 * con `#set enum(numbering: "1)")`, dove è liberamente modificabile.
 *
 * @param {string} markdown
 * @returns {'1.'|'1)'}
 */
export function detectEnumMarker(markdown) {
  let dot = 0;
  let paren = 0;
  for (const line of String(markdown || '').split('\n')) {
    const m = line.match(/^\s*\d+([.)])\s+/);
    if (!m) continue;
    if (m[1] === ')') paren++;
    else dot++;
  }
  return paren > dot ? '1)' : '1.';
}

/** Una voce di elenco numerato: ogni riga del blocco comincia con un numero. */
function isEnumeratedItem(block) {
  const lines = String(block || '').trim().split('\n');
  return lines.length > 0 && lines.every((l) => /^\s*\d+[.)]\s+/.test(l));
}

/** Riga di dialogo: «TERAPISTA:», «FIGLIO:», «PADRE (sorridendo):». */
const DIALOGUE_RE = /^\s*\p{Lu}[\p{Lu}\s'’.-]{1,40}(?:\s*\([^)]{0,80}\))?\s*:/u;

/** Un blocco che non può mai stare dentro una voce di elenco. */
function breaksList(block) {
  const t = String(block || '').trim();
  return /^#{1,6}\s/.test(t) || /^!\[/.test(t) || /^\s*\|/.test(t) || /\\begin\{tabular\}/.test(t);
}

// Oltre questa distanza fra due voci non si tratta più del corpo di una voce
// ma di un elenco che è finito e di un altro che comincia molto dopo.
const MAX_ITEM_BODY = 24;

/**
 * Blocchi da rientrare sotto la voce di elenco che li precede.
 * @param {string[]} blocks blocchi Markdown del documento
 * @returns {Set<number>} indici dei blocchi da rientrare
 */
export function planListNesting(blocks) {
  const nested = new Set();
  for (let i = 0; i < blocks.length; i++) {
    if (!isEnumeratedItem(blocks[i])) continue;

    // Fin dove arriva il corpo di questa voce?
    let next = -1;
    for (let j = i + 1; j < blocks.length && j <= i + MAX_ITEM_BODY; j++) {
      if (breaksList(blocks[j])) break;
      if (isEnumeratedItem(blocks[j])) { next = j; break; }
    }

    if (next > i + 1) {
      for (let j = i + 1; j < next; j++) nested.add(j);
      continue;
    }
    if (next !== -1) continue; // voci consecutive: niente in mezzo

    // Ultima voce: nessun blocco la delimita. Si prosegue finché sono battute
    // di dialogo — l'esempio che illustra la voce — e si smette alla prosa.
    for (let j = i + 1; j < blocks.length; j++) {
      const t = String(blocks[j] || '').trim();
      if (/^<!--/.test(t)) continue; // i marcatori di pagina non interrompono
      if (breaksList(t) || !DIALOGUE_RE.test(t)) break;
      nested.add(j);
    }
  }
  return nested;
}

/** Rientra un blocco perché Typst lo renda dentro la voce che lo precede. */
function indentUnderItem(rendered) {
  return String(rendered)
    .split('\n')
    .map((line) => (line ? `  ${line}` : line))
    .join('\n');
}

export function markdownToStrictTypst(markdown, plan = {}) {
  const blocks = String(markdown || '').trim().split(/\n{2,}/);
  const styleMap = new Map();
  for (const item of plan.blocks || []) styleMap.set(item.id, item.style);
  const headingLevelMap = new Map();
  for (const item of plan.headings || []) {
    if (Number.isInteger(item?.level)) headingLevelMap.set(item.id, Math.max(1, Math.min(6, item.level)));
  }
  const nestedBlocks = planListNesting(blocks);
  const out = [];
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
    const original = blocks[blockIndex];
    const blockId = `b-${blockIndex + 1}`;
    // Restituisce invece di accodare: un blocco che va rientrato dentro una
    // voce di elenco deve poter essere prima stilato e poi rientrato, non
    // perdere lo stile per il fatto di stare dentro.
    const styleProse = (rendered) => {
      const style = styleMap.get(blockId);
      if (style === 'quote') {
        return `#block(inset: (left: 1em), stroke: (left: 0.5pt + luma(170)))[#text(style: "italic")[${rendered}]]`;
      }
      if (style === 'center') return `#align(center)[${rendered}]`;
      if (style === 'compact') return `#block(spacing: 0.45em)[${rendered}]`;
      return rendered;
    };
    const emitProse = (rendered) => {
      const styled = styleProse(rendered);
      out.push(nestedBlocks.has(blockIndex) ? indentUnderItem(styled) : styled);
    };
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
      const level = headingLevelMap.get(blockId) || heading[1].length;
      out.push(`${'='.repeat(level)} ${inlineMarkdownToTypst(heading[2])}`);
      continue;
    }
    const lines = block.split('\n');
    if (lines.every((l) => /^\s*[-*+]\s+/.test(l))) {
      const body = lines
        .map((l) => `- ${inlineMarkdownToTypst(l.replace(/^\s*[-*+]\s+/, ''))}`)
        .join('\n');
      out.push(nestedBlocks.has(blockIndex) ? indentUnderItem(body) : body);
      continue;
    }
    if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) {
      // Il numero SCRITTO NELL'ORIGINALE, non `+`. Typst con `+` numera da sé
      // e riparte da 1 a ogni elenco nuovo: se fra una voce e l'altra c'è un
      // paragrafo — una spiegazione, una trascrizione di seduta — ogni voce
      // diventa un elenco a sé e sono tutte «1.». Verificato col compilatore:
      // `+` dopo un paragrafo riparte, `2.` no.
      const body = lines
        .map((l) => {
          const marker = l.match(/^\s*(\d+)[.)]\s+/);
          const text = inlineMarkdownToTypst(l.replace(/^\s*\d+[.)]\s+/, ''));
          return `${marker[1]}. ${text}`;
        })
        .join('\n');
      out.push(nestedBlocks.has(blockIndex) ? indentUnderItem(body) : body);
      continue;
    }
    // Il paragrafo esce come UNA riga sola. Gli a capo dell'OCR per Typst sono
    // spazi, ma nell'editor spezzavano ogni capoverso in monconi; e il segno di
    // pagina in mezzo — un commento innocuo per il PDF, verificato — tagliava
    // la frase a metà proprio dove si sta leggendo. Il segno resta, ma dopo il
    // paragrafo: il capoverso appartiene alla pagina in cui è cominciato.
    const pageMarks = [];
    const prose = lines
      .map((line) => {
        const pageLine = line.trim().match(/^<!--\s*pagina\s+(\d+)\s*-->$/i);
        if (pageLine) {
          pageMarks.push(`// pagina ${pageLine[1]}`);
          return null;
        }
        return inlineMarkdownToTypst(line);
      })
      .filter((line) => line !== null)
      .join(' ')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
    // Un blocco compreso fra due voci dello stesso elenco appartiene alla
    // prima: rientrandolo, Typst lo rende dentro la voce invece che a margine
    // sinistro, e l'elenco non viene interrotto.
    if (prose) emitProse(prose);
    out.push(...pageMarks);
  }
  return out.join('\n\n');
}

export function describeStrictBlocks(markdown) {
  return String(markdown || '').trim().split(/\n{2,}/).map((original, i) => {
    const text = sourcePlainText(original).replace(/\s+/g, ' ').trim();
    let kind = 'prose';
    if (/^<!--\s*pagina/i.test(original.trim())) kind = 'page-or-prose';
    if (/^(?:<!--\s*pagina\s+\d+\s*-->\s*)?#{1,6}\s/m.test(original.trim())) kind = 'heading';
    else if (/^!\[/m.test(original.trim())) kind = 'figure';
    else if (/\\begin\{tabular\}|^\s*\|/m.test(original)) kind = 'table';
    else if (/^\s*(?:[-+*]|\d+[.)])\s+/m.test(original)) kind = 'list';
    return { id: `b-${i + 1}`, kind, text: text.slice(0, 320) };
  });
}

/** Estrae il testo canonico dal Markdown, escludendo solo metadati e path. */
export function sourcePlainText(markdown) {
  return String(markdown || '')
    .replace(/<!--[^>]*-->/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, ' $1 ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/<\/?footnote>/gi, '')
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
export function buildStrictDocument(markdown, layoutPlan = {}) {
  const body = markdownToStrictTypst(markdown, layoutPlan);
  // Il marcatore dell'autore («1.» o «1)») è una scelta di RESA e vive nel
  // preambolo, dove resta modificabile: qui si legge dal documento solo per
  // partire da quello che c'era invece che da un default arbitrario. Una
  // scelta già espressa dall'utente ha comunque la precedenza.
  const documentOptions = { enumNumbering: detectEnumMarker(markdown), ...(layoutPlan.document || {}) };
  const preamble = buildPreamble(documentOptions, { title: extractTitle(body) });
  // `documentOptions` torna al chiamante perché ciò che è stato DEDOTTO dal
  // documento entri nelle opzioni di impaginazione: altrimenti alla prima
  // ristilizzazione il pannello rimanderebbe una selezione che non contiene
  // il marcatore, e la parentesi dell'autore sparirebbe.
  return { preamble, body, documentOptions, sourceText: sourcePlainText(markdown) };
}

/** Sostituzione ammessa soltanto quando il frammento compare una sola volta. */
export function replaceUniqueText(source, find, replacement) {
  if (!find) return null;
  const first = String(source || '').indexOf(find);
  if (first < 0 || String(source || '').indexOf(find, first + find.length) >= 0) return null;
  return source.slice(0, first) + replacement + source.slice(first + find.length);
}

function exactTextPositions(source, value) {
  if (!value) return [];
  const positions = [];
  let cursor = 0;
  while (cursor <= source.length - value.length) {
    const index = source.indexOf(value, cursor);
    if (index < 0) break;
    positions.push(index);
    cursor = index + Math.max(value.length, 1);
  }
  return positions;
}

function contextualTokenScore(reference, candidate) {
  const left = canonicalTokens(reference);
  const right = canonicalTokens(candidate);
  if (!left.length || !right.length) return 0;
  const available = new Map();
  for (const token of right) available.set(token, (available.get(token) || 0) + 1);
  let common = 0;
  for (const token of left) {
    const count = available.get(token) || 0;
    if (!count) continue;
    common++;
    available.set(token, count - 1);
  }
  return (2 * common) / (left.length + right.length);
}

/**
 * Sostituisce una correzione anche quando il testo corretto ricorre più volte.
 * La posizione viene ricavata dal testo OCR di riferimento e confrontata con
 * il contesto lessicale di ogni candidato nel testo canonico corrente. Se due
 * candidati restano equivalenti la funzione fallisce chiusa.
 *
 * `replaceCount` serve alle correzioni ortografiche registrate come un'unica
 * voce ma applicate intenzionalmente a tutte le occorrenze della stessa parola.
 */
export function replaceContextualText(
  source,
  find,
  replacement,
  {
    referenceSource = '',
    referenceFind = '',
    occurrence = 0,
    replaceCount = 1,
  } = {},
) {
  const current = String(source || '');
  const positions = exactTextPositions(current, find);
  if (!positions.length) return null;
  if (positions.length === 1) {
    const index = positions[0];
    return current.slice(0, index) + replacement + current.slice(index + find.length);
  }

  if (replaceCount > 1) {
    if (positions.length !== replaceCount) return null;
    return current.split(find).join(replacement);
  }

  const reference = String(referenceSource || '');
  const wanted = String(referenceFind || '');
  const referencePositions = exactTextPositions(reference, wanted);
  const referenceIndex = referencePositions[occurrence];
  if (referenceIndex == null) return null;

  // Per passaggi lunghi l'ordine delle occorrenze è già una mappa affidabile:
  // la correzione non può aver creato una nuova copia identica per caso.
  if (
    find.length >= 40 &&
    referencePositions.length === positions.length &&
    occurrence < positions.length
  ) {
    const index = positions[occurrence];
    return current.slice(0, index) + replacement + current.slice(index + find.length);
  }

  const radius = 420;
  const referenceWindow = reference.slice(
    Math.max(0, referenceIndex - radius),
    Math.min(reference.length, referenceIndex + wanted.length + radius),
  );
  const ranked = positions
    .map((index) => ({
      index,
      distance: Math.abs(
        index / Math.max(current.length - find.length, 1) -
        referenceIndex / Math.max(reference.length - wanted.length, 1),
      ),
      score: contextualTokenScore(
        referenceWindow,
        current.slice(
          Math.max(0, index - radius),
          Math.min(current.length, index + find.length + radius),
        ),
      ),
    }))
    .sort((a, b) => b.score - a.score);
  const best = ranked[0];
  const second = ranked[1];
  if (!best || best.score < 0.58) return null;
  if (second && best.score - second.score < 0.08) {
    // Finestre corte possono includere quasi tutto il documento e risultare
    // lessicalmente identiche. In quel caso la posizione relativa rispetto
    // all'OCR è un secondo segnale affidabile, ma solo con un vincitore netto.
    ranked.sort((a, b) => a.distance - b.distance);
    const nearest = ranked[0];
    const runnerUp = ranked[1];
    const margin = Math.max(0.01, 40 / Math.max(current.length, 1));
    if (
      nearest.distance > 0.08 ||
      (runnerUp && runnerUp.distance - nearest.distance < margin)
    ) return null;
    return current.slice(0, nearest.index) + replacement + current.slice(nearest.index + find.length);
  }
  return current.slice(0, best.index) + replacement + current.slice(best.index + find.length);
}

/**
 * Riporta una modifica del testo canonico nel Typst già aperto preservando le
 * eventuali modifiche manuali lontane dal frammento. Il diff locale riceve
 * contesto sufficiente e deve comparire una sola volta nell'editor.
 */
export function rebaseCanonicalRevision(editorCode, currentCanonical, nextCanonical, layoutPlan = {}) {
  const before = buildStrictDocument(currentCanonical, layoutPlan).body;
  const after = buildStrictDocument(nextCanonical, layoutPlan).body;
  if (before === after) return editorCode;
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) suffix++;
  const beforeEnd = before.length - suffix;
  const afterEnd = after.length - suffix;
  // Prova prima il diff minimo: preserva anche modifiche manuali molto vicine.
  // Se è ambiguo, amplia gradualmente il contesto fino a renderlo univoco.
  for (const context of [0, 20, 50, 100, 220, 500, 1000, 2000, 5000]) {
    const left = Math.max(0, prefix - context);
    const rightContext = Math.min(context, suffix);
    const find = before.slice(left, beforeEnd + rightContext);
    const replacement = after.slice(left, afterEnd + rightContext);
    const rebased = replaceUniqueText(editorCode, find, replacement);
    if (rebased != null) return rebased;
  }
  // Se il testo del passaggio è stato già ritoccato nell'editor, la sequenza
  // canonica da sostituire non esiste più byte per byte. Due ancore univoche
  // ai lati permettono comunque di localizzare la sola regione richiesta.
  // È il caso tipico dei libri riletti manualmente e dei paragrafi duplicati:
  // l'unicità viene dal contesto della pagina, non dalla frase isolata.
  for (const context of [100, 220, 500, 1000, 2000, 5000]) {
    const leftStart = Math.max(0, prefix - context);
    const rightEnd = Math.min(before.length, beforeEnd + context);
    const leftAnchor = before.slice(leftStart, prefix);
    const rightAnchor = before.slice(beforeEnd, rightEnd);
    if (leftAnchor.length < 40 || rightAnchor.length < 40) continue;
    const leftPos = editorCode.indexOf(leftAnchor);
    const rightPos = editorCode.indexOf(rightAnchor);
    if (
      leftPos < 0 ||
      rightPos < 0 ||
      editorCode.indexOf(leftAnchor, leftPos + 1) >= 0 ||
      editorCode.indexOf(rightAnchor, rightPos + 1) >= 0
    ) continue;
    const replaceStart = leftPos + leftAnchor.length;
    if (rightPos < replaceStart) continue;
    const expectedLength = beforeEnd - prefix;
    const locatedLength = rightPos - replaceStart;
    if (locatedLength > Math.max(expectedLength * 3, expectedLength + 5000)) continue;
    return editorCode.slice(0, replaceStart) + after.slice(prefix, afterEnd) + editorCode.slice(rightPos);
  }
  return null;
}

/**
 * Variante locale per una singola pagina/paragrafo ritradotto. Renderizza
 * soltanto il passaggio, poi sostituisce il diff minimo univoco nel Typst già
 * modificato dall'utente. In questo modo cento passaggi non richiedono cento
 * rendering dell'intero libro e tutto ciò che è fuori selezione resta byte per
 * byte identico.
 */
export function rebaseStrictPassage(editorCode, beforeMarkdown, afterMarkdown) {
  const before = markdownToStrictTypst(beforeMarkdown);
  const after = markdownToStrictTypst(afterMarkdown);
  if (before === after) return editorCode;
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) suffix++;
  const beforeEnd = before.length - suffix;
  const afterEnd = after.length - suffix;
  for (const context of [0, 20, 50, 100, 220, 500, 1000, 2000, 5000]) {
    const left = Math.max(0, prefix - context);
    const rightContext = Math.min(context, suffix);
    const find = before.slice(left, beforeEnd + rightContext);
    const replacement = after.slice(left, afterEnd + rightContext);
    const rebased = replaceUniqueText(editorCode, find, replacement);
    if (rebased != null) return rebased;
  }
  return null;
}

function normalizedTokenSpans(value) {
  return [...String(value || '').matchAll(/[\p{L}\p{N}]+/gu)].map((match) => ({
    index: match.index,
    end: match.index + match[0].length,
    key: match[0]
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .toLocaleLowerCase('it'),
  }));
}

/**
 * Ultimo ripiego per un passaggio già corretto nell'editor: individua la sua
 * prima e ultima sequenza di parole, entrambe univoche nell'intero Typst. Non
 * viene usato su testi duplicati o con estremi modificati, quindi fallisce in
 * modo chiuso invece di rischiare una sostituzione nel punto sbagliato.
 */
export function rebaseStrictPassageFuzzy(editorCode, beforeMarkdown, afterMarkdown) {
  const source = normalizedTokenSpans(beforeMarkdown);
  if (source.length < 14) return null;
  const editor = normalizedTokenSpans(editorCode);
  const width = Math.min(8, Math.floor(source.length / 3));
  const keyOf = (tokens) => tokens.map((token) => token.key).join('\u0000');
  const firstKey = keyOf(source.slice(0, width));
  const lastKey = keyOf(source.slice(-width));
  let firstIndex = -1;
  let lastIndex = -1;
  let firstMatches = 0;
  let lastMatches = 0;
  for (let index = 0; index + width <= editor.length; index++) {
    const key = keyOf(editor.slice(index, index + width));
    if (key === firstKey) {
      firstIndex = index;
      firstMatches++;
    }
    if (key === lastKey) {
      lastIndex = index;
      lastMatches++;
    }
  }
  if (firstMatches !== 1 || lastMatches !== 1 || lastIndex < firstIndex) return null;
  const locatedWords = lastIndex + width - firstIndex;
  if (locatedWords < source.length * 0.7 || locatedWords > source.length * 1.4) return null;
  const start = editor[firstIndex].index;
  let end = editor[lastIndex + width - 1].end;
  while (end < editorCode.length && /[.,;:!?…»”’"]/u.test(editorCode[end])) end++;
  const rendered = markdownToStrictTypst(afterMarkdown);
  return editorCode.slice(0, start) + rendered + editorCode.slice(end);
}

function uniquePosition(source, value) {
  if (!value || value.length < 40) return -1;
  const first = source.indexOf(value);
  return first >= 0 && source.indexOf(value, first + 1) < 0 ? first : -1;
}

/**
 * Ripristina un passaggio che la fonte canonica contiene ma che è già assente
 * dal Typst. Richiede un'ancora univoca immediatamente prima e una seconda
 * ancora univoca più avanti: senza entrambe non inserisce nulla.
 */
export function rebaseMissingCanonicalPassage(
  editorCode,
  currentCanonical,
  nextCanonical,
  layoutPlan = {},
  beforeMarkdown = '',
  afterMarkdown = '',
) {
  const before = buildStrictDocument(currentCanonical, layoutPlan).body;
  const after = buildStrictDocument(nextCanonical, layoutPlan).body;
  if (before === after) return editorCode;
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) suffix++;
  const beforeEnd = before.length - suffix;
  const afterEnd = after.length - suffix;
  if (beforeEnd - prefix < 40 || afterEnd <= prefix) return null;
  let insertion = after.slice(prefix, afterEnd);
  if (beforeMarkdown && afterMarkdown) {
    const renderedBefore = markdownToStrictTypst(beforeMarkdown);
    const renderedAfter = markdownToStrictTypst(afterMarkdown);
    const oldPosition = before.indexOf(renderedBefore, Math.max(0, prefix - 500));
    if (oldPosition >= 0) {
      const separator = before.slice(oldPosition + renderedBefore.length).match(/^\s+/u)?.[0] || '';
      insertion = renderedAfter + separator;
    }
  }

  for (const leftSize of [60, 100, 220, 500, 1000]) {
    const leftAnchor = before.slice(Math.max(0, prefix - leftSize), prefix);
    const leftPos = uniquePosition(editorCode, leftAnchor);
    if (leftPos < 0) continue;
    const insertionPoint = leftPos + leftAnchor.length;
    // L'ancora seguente può non essere immediata: anche il paragrafo subito
    // dopo potrebbe essere stato riletto. Si cercano finestre più avanti senza
    // includere nel match la zona già divergente.
    for (const distance of [0, 40, 80, 120, 180, 260, 400, 700, 1000, 2000, 5000, 10000]) {
      const start = beforeEnd + distance;
      if (start >= before.length) break;
      const rightAnchor = before.slice(start, Math.min(before.length, start + 100));
      const rightPos = uniquePosition(editorCode, rightAnchor);
      if (rightPos < insertionPoint) continue;
      if (rightPos - insertionPoint > Math.max(20000, distance * 4 + 5000)) continue;
      return editorCode.slice(0, insertionPoint) +
        insertion +
        editorCode.slice(insertionPoint);
    }
  }
  return null;
}

function tokenSimilarity(a, b) {
  const left = new Set(canonicalTokens(a));
  const right = new Set(canonicalTokens(b));
  let common = 0;
  for (const token of left) if (right.has(token)) common++;
  return common / Math.max(left.size, right.size, 1);
}

/**
 * Rigenera dal testo canonico il solo blocco Typst più vicino a una frase
 * discordante. Tutti gli altri blocchi (incluse modifiche manuali) restano.
 */
export function restoreCanonicalPassage(editorCode, canonical, source, layoutPlan = {}) {
  const expectedBlocks = buildStrictDocument(canonical, layoutPlan).body.split(/\n{2,}/);
  const currentBlocks = String(editorCode || '').split(/\n{2,}/);
  const ranked = (blocks) => blocks
    .map((block, index) => ({ block, index, score: tokenSimilarity(block, source) }))
    .sort((a, b) => b.score - a.score);
  const expected = ranked(expectedBlocks)[0];
  const current = ranked(currentBlocks)[0];
  if (!expected || !current || expected.score < 0.45 || current.score < 0.25) return null;
  currentBlocks[current.index] = expected.block;
  return currentBlocks.join('\n\n');
}

/** Invarianti fragili che devono ricomparire esattamente. */
export function extractInvariants(text) {
  const s = String(text || '');
  // Un'unica scansione evita di contare due volte «12,5%» (prima come
  // percentuale e poi come numero) e i numeri già inclusi in URL o DOI.
  return s.match(
    /https?:\/\/[^\s)\]]+|\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+\b|\b\d+(?:[.,]\d+)*(?:\s*%)?/gi,
  ) || [];
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
