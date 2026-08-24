/*
  Costruzione DETERMINISTICA del preambolo Typst. Tutti i valori liberi
  passano da allowlist e limiti numerici prima di entrare nel sorgente.
*/

const FONTS = {
  libertinus: { body: 'Libertinus Serif', head: 'DejaVu Sans' },
  newcm: { body: 'New Computer Modern', head: 'New Computer Modern' },
  ptserif: { body: 'PT Serif', head: 'PT Sans' },
  ptsans: { body: 'PT Sans', head: 'PT Sans' },
  dejavu: { body: 'DejaVu Sans', head: 'DejaVu Sans' },
};

const HEAD_FAMILIES = {
  dejavu: 'DejaVu Sans',
  ptsans: 'PT Sans',
  newcm: 'New Computer Modern',
  libertinus: 'Libertinus Serif',
  ptserif: 'PT Serif',
};

const PAPER = {
  a4: 'a4',
  a5: 'a5',
  b5: 'iso-b5',
  letter: 'us-letter',
  legal: 'us-legal',
};

const TEXT_SIZE = { small: 10, normal: 11, large: 12, xlarge: 13 };
const HEADING_SIZE = {
  small: [16, 13, 11.5, 10.5],
  normal: [17, 14, 12, 11],
  large: [19, 15.5, 13, 12],
  xlarge: [21, 17, 14, 13],
};

export const DEFAULT_LAYOUT_OPTIONS = Object.freeze({
  font: 'libertinus',
  bodySizePt: 11,
  bodyWeight: 400,
  language: 'it',
  trackingPt: 0,
  hyphenate: false,
  headfont: 'dejavu',
  heading1Pt: 17,
  heading2Pt: 14,
  heading3Pt: 12,
  heading4Pt: 11,
  headingWeight: 700,
  headingalign: 'left',
  headingAboveEm: 1.4,
  headingBelowEm: 0.75,
  headingNumbering: 'none',
  enumNumbering: '1.',
  paper: 'a4',
  pageWidthMm: 210,
  pageHeightMm: 297,
  orientation: 'portrait',
  marginMode: 'preset',
  marginPreset: 'wide',
  marginTopCm: 2.5,
  marginRightCm: 4,
  marginBottomCm: 2.5,
  marginLeftCm: 2.5,
  marginInsideCm: 3,
  marginOutsideCm: 2,
  binding: 'left',
  columns: 1,
  align: 'justify',
  linebreaks: 'optimized',
  leadingEm: 0.65,
  paragraphSpacingEm: 1.1,
  indentEm: 1.2,
  indentAll: false,
  pageNumbering: 'none',
  pageNumberPosition: 'bottom-center',
  headerMode: 'none',
  headerText: '',
  headerAlign: 'center',
  headerSizePt: 8.5,
  headerRule: false,
  chapterBreak: false,
  chapterOpener: 'none',
  figureAlign: 'center',
  captionPosition: 'bottom',
  captionSizePt: 9,
  footnoteSizePt: 9,
  footnoteGapEm: 0.5,
});

function clamp(value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function rounded(value) {
  return Number(value.toFixed(3));
}

function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function esc(s) {
  return String(s || '').replace(/\\/gu, '\\\\').replace(/"/gu, '\\"');
}

/** Estrae il titolo (primo titolo `= …`) dal corpo, per la testatina. */
export function extractTitle(body) {
  const match = String(body || '').match(/^=\s+(.+)$/mu);
  return match ? match[1].trim() : '';
}

/** Migra le selezioni a chip precedenti nel nuovo schema numerico. */
export function normalizeLayoutOptions(selection = {}) {
  const extras = new Set(
    Array.isArray(selection.extras)
      ? selection.extras
      : selection.extras
        ? [selection.extras]
        : [],
  );
  const textKey = TEXT_SIZE[selection.textsize] ? selection.textsize : 'normal';
  const density = selection.density;
  const legacyIndent = {
    none: 0,
    small: 0.7,
    normal: 1.2,
    deep: 1.8,
  }[selection.indent];
  const legacyMargin = oneOf(selection.margin, ['wide', 'xwide', 'sym', 'narrow'], 'wide');
  const columns = { one: 1, two: 2, three: 3 }[selection.columns] ?? selection.columns;
  const headingDefaults = HEADING_SIZE[textKey];

  return {
    font: oneOf(selection.font, Object.keys(FONTS), DEFAULT_LAYOUT_OPTIONS.font),
    bodySizePt: rounded(clamp(selection.bodySizePt, TEXT_SIZE[textKey], 8, 24)),
    bodyWeight: rounded(clamp(selection.bodyWeight, 400, 300, 700)),
    language: oneOf(selection.language, ['it', 'en', 'fr', 'de', 'es', 'pt'], 'it'),
    trackingPt: rounded(clamp(selection.trackingPt, 0, -0.2, 1.5)),
    hyphenate: selection.hyphenate === true || extras.has('hyphenate'),
    headfont: oneOf(selection.headfont, ['body', ...Object.keys(HEAD_FAMILIES)], 'dejavu'),
    heading1Pt: rounded(clamp(selection.heading1Pt, headingDefaults[0], 10, 42)),
    heading2Pt: rounded(clamp(selection.heading2Pt, headingDefaults[1], 9, 36)),
    heading3Pt: rounded(clamp(selection.heading3Pt, headingDefaults[2], 8, 30)),
    heading4Pt: rounded(clamp(selection.heading4Pt, headingDefaults[3], 8, 26)),
    headingWeight: rounded(clamp(selection.headingWeight, 700, 400, 900)),
    headingalign: oneOf(selection.headingalign, ['left', 'center', 'right'], 'left'),
    headingAboveEm: rounded(clamp(selection.headingAboveEm, 1.4, 0, 5)),
    headingBelowEm: rounded(clamp(selection.headingBelowEm, 0.75, 0, 4)),
    headingNumbering: extras.has('numbered')
      ? 'decimal'
      : oneOf(selection.headingNumbering, ['none', 'decimal', 'decimal-dot', 'roman'], 'none'),
    // Marcatore delle voci di elenco numerato. È RESA, non struttura: Typst
    // riconosce l'elenco solo dalla forma «1.», ma può stamparlo «1)» come
    // fanno molti saggi italiani. Senza questa opzione la parentesi
    // dell'autore andrebbe persa nella conversione.
    enumNumbering: oneOf(selection.enumNumbering, ['1.', '1)', 'a)', 'i.'], '1.'),
    paper: oneOf(selection.paper, [...Object.keys(PAPER), 'custom'], 'a4'),
    pageWidthMm: rounded(clamp(selection.pageWidthMm, 210, 80, 500)),
    pageHeightMm: rounded(clamp(selection.pageHeightMm, 297, 80, 700)),
    orientation: oneOf(selection.orientation, ['portrait', 'landscape'], 'portrait'),
    marginMode: oneOf(selection.marginMode, ['preset', 'custom', 'mirrored'], 'preset'),
    marginPreset: oneOf(selection.marginPreset || legacyMargin, ['wide', 'xwide', 'sym', 'narrow'], 'wide'),
    marginTopCm: rounded(clamp(selection.marginTopCm, 2.5, 0.5, 12)),
    marginRightCm: rounded(clamp(selection.marginRightCm, legacyMargin === 'xwide' ? 6 : legacyMargin === 'narrow' ? 2 : legacyMargin === 'sym' ? 2.5 : 4, 0.5, 12)),
    marginBottomCm: rounded(clamp(selection.marginBottomCm, 2.5, 0.5, 12)),
    marginLeftCm: rounded(clamp(selection.marginLeftCm, legacyMargin === 'narrow' ? 2 : 2.5, 0.5, 12)),
    marginInsideCm: rounded(clamp(selection.marginInsideCm, 3, 0.5, 12)),
    marginOutsideCm: rounded(clamp(selection.marginOutsideCm, 2, 0.5, 12)),
    binding: oneOf(selection.binding, ['left', 'right'], 'left'),
    columns: Math.round(clamp(columns, 1, 1, 3)),
    align: oneOf(selection.align, ['justify', 'ragged'], 'justify'),
    linebreaks: oneOf(selection.linebreaks, ['optimized', 'simple'], 'optimized'),
    leadingEm: rounded(clamp(selection.leadingEm, density === 'airy' ? 0.85 : density === 'compact' ? 0.55 : 0.65, 0.35, 2)),
    paragraphSpacingEm: rounded(clamp(selection.paragraphSpacingEm, density === 'airy' ? 1.4 : density === 'compact' ? 0.8 : 1.1, 0, 4)),
    indentEm: rounded(clamp(selection.indentEm, extras.has('noindent') ? 0 : legacyIndent ?? 1.2, 0, 5)),
    indentAll: selection.indentAll === true,
    pageNumbering: extras.has('pagenums')
      ? 'arabic'
      : oneOf(selection.pageNumbering, ['none', 'arabic', 'roman-lower', 'roman-upper'], 'none'),
    pageNumberPosition: oneOf(selection.pageNumberPosition, ['bottom-left', 'bottom-center', 'bottom-right'], 'bottom-center'),
    headerMode: extras.has('runninghead')
      ? 'title'
      : oneOf(selection.headerMode, ['none', 'title', 'chapter', 'custom'], 'none'),
    headerText: String(selection.headerText || '').slice(0, 180),
    headerAlign: oneOf(selection.headerAlign, ['left', 'center', 'right'], 'center'),
    headerSizePt: rounded(clamp(selection.headerSizePt, 8.5, 6, 16)),
    // Filetto sotto la testatina: lo stesso segno che separa il corpo dalle
    // note, in cima alla pagina.
    headerRule: selection.headerRule === true,
    chapterBreak: selection.chapterBreak === true,
    chapterOpener: oneOf(selection.chapterOpener, ['none', 'smallcaps', 'versal'], 'none'),
    figureAlign: oneOf(selection.figureAlign, ['left', 'center', 'right'], 'center'),
    captionPosition: oneOf(selection.captionPosition, ['top', 'bottom'], 'bottom'),
    captionSizePt: rounded(clamp(selection.captionSizePt, 9, 6, 16)),
    footnoteSizePt: rounded(clamp(selection.footnoteSizePt, 9, 6, 16)),
    footnoteGapEm: rounded(clamp(selection.footnoteGapEm, 0.5, 0, 3)),
  };
}

function marginValue(options) {
  if (options.marginMode === 'custom') {
    return `(top: ${options.marginTopCm}cm, right: ${options.marginRightCm}cm, bottom: ${options.marginBottomCm}cm, left: ${options.marginLeftCm}cm)`;
  }
  if (options.marginMode === 'mirrored') {
    return `(top: ${options.marginTopCm}cm, bottom: ${options.marginBottomCm}cm, inside: ${options.marginInsideCm}cm, outside: ${options.marginOutsideCm}cm)`;
  }
  if (options.marginPreset === 'xwide') return '(right: 6cm, top: 2.5cm, bottom: 2.5cm, left: 2.5cm)';
  if (options.marginPreset === 'narrow') return '2cm';
  if (options.marginPreset === 'sym') return '2.5cm';
  return '(right: 4cm, top: 2.5cm, bottom: 2.5cm, left: 2.5cm)';
}

/** Costruisce un preambolo Typst valido dalle selezioni del pannello stile. */
export function buildPreamble(selection = {}, opts = {}) {
  const options = normalizeLayoutOptions(selection);
  const family = FONTS[options.font];
  const headFont = options.headfont === 'body'
    ? family.body
    : HEAD_FAMILIES[options.headfont] || family.head;
  const pageParts = [];

  if (options.paper === 'custom') {
    const width = options.orientation === 'landscape' ? options.pageHeightMm : options.pageWidthMm;
    const height = options.orientation === 'landscape' ? options.pageWidthMm : options.pageHeightMm;
    pageParts.push(`width: ${width}mm`, `height: ${height}mm`);
  } else {
    pageParts.push(`paper: "${PAPER[options.paper]}"`);
    if (options.orientation === 'landscape') pageParts.push('flipped: true');
  }
  pageParts.push(`margin: ${marginValue(options)}`);
  if (options.marginMode === 'mirrored') pageParts.push(`binding: ${options.binding}`);
  if (options.columns > 1) pageParts.push(`columns: ${options.columns}`);

  const pageNumberPatterns = {
    arabic: '1',
    'roman-lower': 'i',
    'roman-upper': 'I',
  };
  if (options.pageNumbering !== 'none') {
    const alignment = {
      'bottom-left': 'left + bottom',
      'bottom-center': 'center + bottom',
      'bottom-right': 'right + bottom',
    }[options.pageNumberPosition];
    pageParts.push(`numbering: "${pageNumberPatterns[options.pageNumbering]}"`);
    pageParts.push(`number-align: ${alignment}`);
  }

  const headerValue = options.headerMode === 'title'
    ? opts.title
    : options.headerMode === 'custom'
      ? options.headerText
      : '';
  // Corpo della testatina: o un testo fisso, o — modalità «capitolo» — il
  // titolo del capitolo in corso, che è quello che fa sembrare un libro un
  // libro. Sulla pagina in cui il capitolo COMINCIA la testatina si toglie,
  // come si è sempre fatto in tipografia: lì il titolo è già sotto.
  const headerBody = options.headerMode === 'chapter'
    ? 'capitolo'
    : headerValue
      ? `text("${esc(headerValue)}", size: ${options.headerSizePt}pt, style: "italic", fill: luma(35%))`
      : '';
  if (headerBody) {
    const rule = options.headerRule
      ? `block(width: 100%, above: 0pt, below: 0pt, inset: (bottom: 0.35em), stroke: (bottom: 0.5pt + luma(60%)), align(${options.headerAlign}, CONTENUTO))`
      : `align(${options.headerAlign}, CONTENUTO)`;
    if (options.headerMode === 'chapter') {
      pageParts.push(
        'header: context {\n' +
        '  let capitoli = query(heading.where(level: 1))\n' +
        '  let pagina = here().page()\n' +
        '  let apre = capitoli.filter(h => h.location().page() == pagina).len() > 0\n' +
        '  let prima = capitoli.filter(h => h.location().page() < pagina)\n' +
        '  if not apre and prima.len() > 0 {\n' +
        `    ${rule.replace('CONTENUTO', `text(size: ${options.headerSizePt}pt, style: "italic", fill: luma(35%), prima.last().body)`)}\n` +
        '  }\n' +
        '}',
      );
    } else {
      pageParts.push(`header: ${rule.replace('CONTENUTO', headerBody)}`);
    }
  }

  const indent = options.indentAll
    ? `(amount: ${options.indentEm}em, all: true)`
    : `${options.indentEm}em`;
  const headingNumbering = {
    decimal: '1.1',
    'decimal-dot': '1.1.',
    roman: 'I.1',
  }[options.headingNumbering];

  const lines = [
    `#set page(${pageParts.join(', ')})`,
    `#set text(font: "${esc(family.body)}", size: ${options.bodySizePt}pt, weight: ${options.bodyWeight}, tracking: ${options.trackingPt}pt, lang: "${options.language}", hyphenate: ${options.hyphenate})`,
    `#set par(justify: ${options.align === 'justify'}, linebreaks: "${options.linebreaks}", leading: ${options.leadingEm}em, spacing: ${options.paragraphSpacingEm}em, first-line-indent: ${indent})`,
    `#show heading: set text(font: "${esc(headFont)}", weight: ${options.headingWeight})`,
    `#show heading: set block(above: ${options.headingAboveEm}em, below: ${options.headingBelowEm}em)`,
    `#show heading: set align(${options.headingalign})`,
    `#show heading.where(level: 1): set text(size: ${options.heading1Pt}pt)`,
    `#show heading.where(level: 2): set text(size: ${options.heading2Pt}pt)`,
    `#show heading.where(level: 3): set text(size: ${options.heading3Pt}pt)`,
    `#show heading.where(level: 4): set text(size: ${options.heading4Pt}pt)`,
    `#show figure: set align(${options.figureAlign})`,
    `#show figure.caption: set text(size: ${options.captionSizePt}pt)`,
    `#show figure.caption: set align(${options.figureAlign})`,
    `#show figure.caption: set figure.caption(position: ${options.captionPosition})`,
    `#show footnote.entry: set text(size: ${options.footnoteSizePt}pt)`,
    `#set footnote.entry(gap: ${options.footnoteGapEm}em)`,
  ];
  if (options.chapterBreak) {
    // `weak: true`: nessuna pagina bianca se il capitolo è già in cima.
    lines.push('#show heading.where(level: 1): it => { pagebreak(weak: true); it }');
  }
  // `#apertura[…]` marca il primo paragrafo di un capitolo (vedi bookStyle.js).
  // La definizione c'è SEMPRE, anche a stile spento: un corpo marcato da un
  // giro precedente deve continuare a compilare.
  lines.push(aperturaHelper(options.chapterOpener));
  if (headingNumbering) lines.push(`#set heading(numbering: "${headingNumbering}")`);
  if (options.enumNumbering && options.enumNumbering !== '1.') {
    lines.push(`#set enum(numbering: "${options.enumNumbering}")`);
  }
  return lines.join('\n');
}

/**
 * Definizione di `#apertura`, il marcatore del primo paragrafo di un capitolo.
 *
 * Il testo arriva come contenuto: quando è prosa semplice si può prendere la
 * prima lettera (o le prime parole) e trattarla; quando invece comincia con
 * del corsivo o una nota, non lo si tocca — meglio nessun fregio che un
 * fregio sbagliato.
 */
function aperturaHelper(mode) {
  if (mode === 'smallcaps') {
    return [
      '#let apertura(corpo) = {',
      '  if corpo.has("text") {',
      '    let parole = corpo.text.split(" ")',
      '    if parole.len() > 4 {',
      '      smallcaps(parole.slice(0, 4).join(" ")) + " " + parole.slice(4).join(" ")',
      '    } else { smallcaps(corpo) }',
      '  } else { corpo }',
      '}',
    ].join('\n');
  }
  if (mode === 'versal') {
    return [
      '#let apertura(corpo) = {',
      '  set par(first-line-indent: 0em)',
      '  if corpo.has("text") and corpo.text.clusters().len() > 1 {',
      '    let lettere = corpo.text.clusters()',
      '    text(size: 2.4em, weight: 700, lettere.first()) + lettere.slice(1).join("")',
      '  } else { corpo }',
      '}',
    ].join('\n');
  }
  return '#let apertura(corpo) = corpo';
}

/** Migra i vecchi documenti: se manca la scelta, disattiva la sillabazione. */
export function ensureExplicitHyphenation(code) {
  const source = String(code || '');
  if (/\bhyphenate\s*:/u.test(source)) return source;
  const textSet = /#set\s+text\(([^\n)]*)\)/u;
  if (textSet.test(source)) {
    return source.replace(textSet, (_, options) => `#set text(${options.trim()}, hyphenate: false)`);
  }
  return `#set text(hyphenate: false)\n${source}`;
}
