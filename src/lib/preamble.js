/*
  Costruzione DETERMINISTICA del preambolo Typst dalle scelte di impaginazione,
  senza interpellare l'LLM. Permette di cambiare font, margini, colonne, ecc.
  a posteriori sostituendo solo il preambolo del documento già generato.
*/

const FONTS = {
  libertinus: { body: 'Libertinus Serif', head: 'DejaVu Sans' },
  newcm: { body: 'New Computer Modern', head: 'New Computer Modern' },
  ptserif: { body: 'PT Serif', head: 'PT Sans' },
  ptsans: { body: 'PT Sans', head: 'PT Sans' },
  dejavu: { body: 'DejaVu Sans', head: 'DejaVu Sans' },
};
// Famiglie selezionabili per i titoli, indipendenti dal corpo.
const HEAD_FAMILIES = {
  dejavu: 'DejaVu Sans',
  ptsans: 'PT Sans',
  newcm: 'New Computer Modern',
  libertinus: 'Libertinus Serif',
  ptserif: 'PT Serif',
};
const PAPER = { a4: 'a4', a5: 'a5', letter: 'us-letter' };
const TEXT_SIZE = { small: '10pt', normal: '11pt', large: '12pt', xlarge: '13pt' };
const HEADING_SIZE = {
  small: ['16pt', '13pt', '11.5pt', '10.5pt'],
  normal: ['17pt', '14pt', '12pt', '11pt'],
  large: ['19pt', '15.5pt', '13pt', '12pt'],
  xlarge: ['21pt', '17pt', '14pt', '13pt'],
};

/** Estrae il titolo (primo titolo `= …`) dal corpo, per la testatina. */
export function extractTitle(body) {
  const m = body.match(/^=\s+(.+)$/m);
  return m ? m[1].trim() : '';
}

/** Escape del testo per inserirlo in una stringa Typst `"..."`. */
function esc(s) {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Costruisce un preambolo Typst valido dalle selezioni del pannello stile.
 * @param {Record<string,string>} sel  es. { font:'ptserif', paper:'a4', margin:'wide', ... }
 * @param {{title?:string}} [opts]
 * @returns {string}
 */
export function buildPreamble(sel = {}, opts = {}) {
  const f = FONTS[sel.font] || FONTS.libertinus;
  const paper = PAPER[sel.paper] || 'a4';
  // I titoli seguono la scelta dedicata; "body" = stesso font del corpo;
  // in assenza di scelta, l'abbinamento predefinito della famiglia del corpo.
  const headFont =
    sel.headfont === 'body' ? f.body : HEAD_FAMILIES[sel.headfont] || f.head;
  // Extra multi-selezione (retro-compatibile con il vecchio valore singolo).
  const extras = new Set(
    Array.isArray(sel.extras) ? sel.extras : sel.extras ? [sel.extras] : [],
  );

  let margin;
  if (sel.margin === 'xwide') margin = '(right: 6cm, top: 2.5cm, bottom: 2.5cm, left: 2.5cm)';
  else if (sel.margin === 'narrow') margin = '2cm';
  else if (sel.margin === 'sym') margin = '2.5cm';
  else margin = '(right: 4cm, top: 2.5cm, bottom: 2.5cm, left: 2.5cm)';

  const pageParts = [`paper: "${paper}"`, `margin: ${margin}`];
  if (sel.orientation === 'landscape') pageParts.push('flipped: true');
  if (sel.columns === 'two') pageParts.push('columns: 2');
  if (sel.columns === 'three') pageParts.push('columns: 3');
  if (extras.has('pagenums')) pageParts.push('numbering: "1"');
  if (extras.has('runninghead') && opts.title) {
    pageParts.push(
      `header: align(center)[#text(size: 9pt, style: "italic", fill: luma(90))[${
        // titolo come contenuto: usa testo grezzo escapando le parentesi quadre
        opts.title.replace(/([\[\]])/g, '\\$1')
      }]]`,
    );
  }

  const justify = sel.align === 'ragged' ? 'false' : 'true';
  const leading = sel.density === 'airy' ? '0.85em' : sel.density === 'compact' ? '0.55em' : '0.65em';
  const spacing = sel.density === 'airy' ? '1.4em' : sel.density === 'compact' ? '0.8em' : '1.1em';
  const indent = extras.has('noindent') || sel.indent === 'none'
    ? '0em'
    : sel.indent === 'small'
      ? '0.7em'
      : sel.indent === 'deep'
        ? '1.8em'
        : '1.2em';
  const sizeKey = TEXT_SIZE[sel.textsize] ? sel.textsize : 'normal';
  const headingSizes = HEADING_SIZE[sizeKey];
  const textOptions = [
    `font: "${esc(f.body)}"`,
    `size: ${TEXT_SIZE[sizeKey]}`,
    'lang: "it"',
    // Typst può sillabare automaticamente in base alla lingua. La scelta
    // predefinita dell'app è esplicitamente NO: si abilita solo dall'opzione
    // «Sillabazione» nel pannello di impaginazione.
    `hyphenate: ${extras.has('hyphenate') ? 'true' : 'false'}`,
  ];

  const lines = [
    `#set page(${pageParts.join(', ')})`,
    `#set text(${textOptions.join(', ')})`,
    // Scala tipografica ESPLICITA per livello: gerarchia visiva coerente
    // qualunque sia il font scelto per i titoli.
    `#show heading: set text(font: "${esc(headFont)}")`,
    `#show heading.where(level: 1): set text(size: ${headingSizes[0]})`,
    `#show heading.where(level: 2): set text(size: ${headingSizes[1]})`,
    `#show heading.where(level: 3): set text(size: ${headingSizes[2]})`,
    `#show heading.where(level: 4): set text(size: ${headingSizes[3]})`,
  ];
  if (sel.headingalign === 'center') lines.push('#show heading: it => align(center, it)');
  if (sel.headingalign === 'right') lines.push('#show heading: it => align(right, it)');
  if (extras.has('numbered')) lines.push('#set heading(numbering: "1.1")');
  lines.push(
    `#set par(justify: ${justify}, leading: ${leading}, first-line-indent: ${indent})`,
    `#show par: set block(spacing: ${spacing})`,
  );
  return lines.join('\n');
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
