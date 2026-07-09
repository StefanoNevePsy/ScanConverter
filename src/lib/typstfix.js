/*
  Correzione automatica degli errori Typst più comuni prodotti dagli LLM
  (specie da chat esterne). Applica solo trasformazioni ad alta confidenza e
  restituisce l'elenco delle modifiche fatte, così l'utente sa cosa è cambiato.
*/

// Font non disponibili → equivalenti impacchettati.
const FONT_MAP = {
  'Linux Libertine': 'Libertinus Serif',
  Libertine: 'Libertinus Serif',
  'Latin Modern Roman': 'New Computer Modern',
  'Computer Modern': 'New Computer Modern',
  'Liberation Sans': 'DejaVu Sans',
  'Liberation Serif': 'Libertinus Serif',
  'Times New Roman': 'Libertinus Serif',
  Times: 'Libertinus Serif',
  Georgia: 'Libertinus Serif',
  Arial: 'DejaVu Sans',
  Helvetica: 'DejaVu Sans',
  Verdana: 'DejaVu Sans',
  'Courier New': 'DejaVu Sans Mono',
  Courier: 'DejaVu Sans Mono',
};

/**
 * @param {string} source
 * @returns {{ fixed: string, changes: string[] }}
 */
export function autofixTypst(source) {
  let s = source;
  const changes = [];
  const count = (re) => (s.match(re) || []).length;

  // 1) Titoli Markdown non convertiti: `## Titolo` → `== Titolo`.
  const mdHeads = count(/^[ \t]{0,3}#{1,6}[ \t]+\S/gm);
  if (mdHeads) {
    s = s.replace(/^([ \t]{0,3})(#{1,6})([ \t]+)/gm, (_, sp, h, tail) => sp + '='.repeat(h.length) + tail);
    changes.push(`${mdHeads} titolo/i Markdown "#" → "="`);
  }

  // 2) #set paragraph(...) → #set par(...)  (paragraph non esiste).
  const parFix = count(/#set\s+paragraph\s*\(/g);
  if (parFix) {
    s = s.replace(/#set\s+paragraph\s*\(/g, '#set par(');
    changes.push(`${parFix} "#set paragraph" → "#set par"`);
  }

  // 3) block(top:/bottom:) → block(above:/below:)  (top/bottom non esistono su block).
  let blockFix = 0;
  s = s.replace(/\bblock\(([^)\[]*)\)/g, (whole, args) => {
    if (!/\b(top|bottom)\s*:/.test(args)) return whole;
    blockFix++;
    const a2 = args.replace(/\btop\s*:/g, 'above:').replace(/\bbottom\s*:/g, 'below:');
    return `block(${a2})`;
  });
  if (blockFix) changes.push(`${blockFix} block(top/bottom) → block(above/below)`);

  // 4) Font non disponibili → equivalenti.
  let fontFix = 0;
  for (const [bad, good] of Object.entries(FONT_MAP)) {
    const re = new RegExp(`"${bad.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'g');
    const n = count(re);
    if (n) {
      s = s.replace(re, `"${good}"`);
      fontFix += n;
    }
  }
  if (fontFix) changes.push(`${fontFix} nome/i font non disponibili sostituiti`);

  // 5) "unclosed label": `<` seguito da spazio o a fine riga non è un'etichetta
  //    valida → lo si scrive come `\<`. Non tocca `<etichetta>` né `<->` (math).
  const strayLt = count(/<(?=\s|$)/gm);
  if (strayLt) {
    s = s.replace(/<(?=\s|$)/gm, '\\<');
    changes.push(`${strayLt} carattere "<" problematico protetto (\\<)`);
  }

  return { fixed: s, changes };
}
