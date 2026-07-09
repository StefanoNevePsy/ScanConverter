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
const PAPER = { a4: 'a4', a5: 'a5', letter: 'us-letter' };

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

  let margin;
  if (sel.margin === 'xwide') margin = '(right: 6cm, top: 2.5cm, bottom: 2.5cm, left: 2.5cm)';
  else if (sel.margin === 'sym') margin = '2.5cm';
  else margin = '(right: 4cm, top: 2.5cm, bottom: 2.5cm, left: 2.5cm)';

  const pageParts = [`paper: "${paper}"`, `margin: ${margin}`];
  if (sel.columns === 'two') pageParts.push('columns: 2');
  if (sel.extras === 'pagenums') pageParts.push('numbering: "1"');
  if (sel.extras === 'runninghead' && opts.title) {
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

  const lines = [
    `#set page(${pageParts.join(', ')})`,
    `#set text(font: "${esc(f.body)}", size: 11pt, lang: "it")`,
    `#show heading: set text(font: "${esc(f.head)}")`,
  ];
  if (sel.extras === 'numbered') lines.push('#set heading(numbering: "1.1")');
  lines.push(
    `#set par(justify: ${justify}, leading: ${leading}, first-line-indent: 1.2em)`,
    `#show par: set block(spacing: ${spacing})`,
  );
  return lines.join('\n');
}
