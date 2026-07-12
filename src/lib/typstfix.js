/*
  Correzione automatica degli errori Typst più comuni prodotti dagli LLM
  (specie da chat esterne). Applica solo trasformazioni ad alta confidenza e
  restituisce l'elenco delle modifiche fatte, così l'utente sa cosa è cambiato.
*/

// Comandi matematici LaTeX → sintassi Typst. Gli LLM (e le chat esterne)
// producono spesso `$\leftrightarrow$`, `$\alpha$`, ecc.: in Typst il `\l`
// è un escape del carattere `l`, così `\leftrightarrow` diventa il testo
// letterale "eftrightarrow" e i `\left(` / `\right)` lasciano parentesi
// sbilanciate → "unclosed delimiter". Convertirli risolve entrambi i casi.
// Ogni valore ha uno spazio finale per non incollare token adiacenti
// (`\alpha\beta` → `alpha beta`, non `alphabeta`).
const MATH_SYMBOLS = {
  // Frecce
  leftrightarrow: '<-> ',
  Leftrightarrow: '<=> ',
  longleftrightarrow: '<-> ',
  rightarrow: '-> ',
  longrightarrow: '-> ',
  Rightarrow: '=> ',
  Longrightarrow: '=> ',
  to: '-> ',
  gets: '<- ',
  leftarrow: '<- ',
  longleftarrow: '<- ',
  Leftarrow: 'arrow.l.double ',
  mapsto: '|-> ',
  uparrow: 'arrow.t ',
  downarrow: 'arrow.b ',
  // Operatori / relazioni
  times: 'times ',
  div: 'div ',
  cdot: 'dot.c ',
  pm: 'plus.minus ',
  mp: 'minus.plus ',
  ast: '* ',
  star: 'star ',
  circ: 'compose ',
  leq: '<= ',
  le: '<= ',
  geq: '>= ',
  ge: '>= ',
  neq: '!= ',
  ne: '!= ',
  approx: 'approx ',
  equiv: 'equiv ',
  cong: 'tilde.equiv ',
  sim: 'tilde.op ',
  simeq: 'tilde.eq ',
  propto: 'prop ',
  ll: '<< ',
  gg: '>> ',
  // Insiemi / logica
  infty: 'infinity ',
  partial: 'diff ',
  nabla: 'nabla ',
  forall: 'forall ',
  exists: 'exists ',
  nexists: 'exists.not ',
  in: 'in ',
  notin: 'in.not ',
  ni: 'in.rev ',
  subset: 'subset ',
  subseteq: 'subset.eq ',
  supset: 'supset ',
  supseteq: 'supset.eq ',
  cup: 'union ',
  cap: 'sect ',
  setminus: 'without ',
  emptyset: 'emptyset ',
  varnothing: 'nothing ',
  neg: 'not ',
  lnot: 'not ',
  land: 'and ',
  lor: 'or ',
  wedge: 'and ',
  vee: 'or ',
  oplus: 'plus.circle ',
  otimes: 'times.circle ',
  // Grandi operatori
  sum: 'sum ',
  prod: 'product ',
  int: 'integral ',
  iint: 'integral.double ',
  oint: 'integral.cont ',
  bigcup: 'union.big ',
  bigcap: 'sect.big ',
  // Puntini / vari
  ldots: 'dots.h ',
  cdots: 'dots.h.c ',
  vdots: 'dots.v ',
  ddots: 'dots.down ',
  dots: 'dots.h ',
  ell: 'ell ',
  hbar: 'planck.reduce ',
  angle: 'angle ',
  perp: 'perp ',
  parallel: 'parallel ',
  prime: 'prime ',
  degree: 'degree ',
  // Lettere greche minuscole
  alpha: 'alpha ',
  beta: 'beta ',
  gamma: 'gamma ',
  delta: 'delta ',
  epsilon: 'epsilon ',
  varepsilon: 'epsilon.alt ',
  zeta: 'zeta ',
  eta: 'eta ',
  theta: 'theta ',
  vartheta: 'theta.alt ',
  iota: 'iota ',
  kappa: 'kappa ',
  lambda: 'lambda ',
  mu: 'mu ',
  nu: 'nu ',
  xi: 'xi ',
  pi: 'pi ',
  varpi: 'pi.alt ',
  rho: 'rho ',
  varrho: 'rho.alt ',
  sigma: 'sigma ',
  varsigma: 'sigma.alt ',
  tau: 'tau ',
  upsilon: 'upsilon ',
  phi: 'phi ',
  varphi: 'phi.alt ',
  chi: 'chi ',
  psi: 'psi ',
  omega: 'omega ',
  // Lettere greche maiuscole
  Gamma: 'Gamma ',
  Delta: 'Delta ',
  Theta: 'Theta ',
  Lambda: 'Lambda ',
  Xi: 'Xi ',
  Pi: 'Pi ',
  Sigma: 'Sigma ',
  Upsilon: 'Upsilon ',
  Phi: 'Phi ',
  Psi: 'Psi ',
  Omega: 'Omega ',
};

// Comandi LaTeX con un argomento fra graffe: `\cmd{A}` → costrutto Typst.
const MATH_BRACE1 = {
  sqrt: (a) => `sqrt(${a})`,
  text: (a) => `"${a}"`,
  mathrm: (a) => `upright(${a})`,
  operatorname: (a) => `op("${a}")`,
  mathbf: (a) => `bold(${a})`,
  boldsymbol: (a) => `bold(${a})`,
  mathbb: (a) => `bb(${a})`,
  mathcal: (a) => `cal(${a})`,
  mathfrak: (a) => `frak(${a})`,
  mathsf: (a) => `sans(${a})`,
  mathit: (a) => `italic(${a})`,
  hat: (a) => `hat(${a})`,
  widehat: (a) => `hat(${a})`,
  bar: (a) => `macron(${a})`,
  overline: (a) => `overline(${a})`,
  underline: (a) => `underline(${a})`,
  tilde: (a) => `tilde(${a})`,
  widetilde: (a) => `tilde(${a})`,
  vec: (a) => `arrow(${a})`,
  dot: (a) => `dot(${a})`,
  ddot: (a) => `dot.double(${a})`,
};

/**
 * Converte i comandi matematici LaTeX in sintassi Typst.
 * @param {string} source
 * @returns {{ text: string, n: number }} testo convertito e numero di sostituzioni
 */
export function convertLatexMath(source) {
  let s = source;
  let n = 0;
  const bump = (re) => {
    const c = (s.match(re) || []).length;
    n += c;
    return c;
  };

  // 1) Frazioni: `\frac{A}{B}` → `frac(A, B)` (un livello di graffe).
  //    Ripetuto per gestire annidamenti semplici.
  for (let i = 0; i < 3; i++) {
    const re = /\\(?:d|t)?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g;
    if (!bump(re)) break;
    s = s.replace(re, 'frac($1, $2)');
  }

  // 2) Comandi con un argomento fra graffe: `\sqrt{A}`, `\text{A}`, accenti…
  for (const [cmd, fn] of Object.entries(MATH_BRACE1)) {
    for (let i = 0; i < 3; i++) {
      const re = new RegExp(`\\\\${cmd}\\s*\\{([^{}]*)\\}`, 'g');
      if (!bump(re)) break;
      s = s.replace(re, (_, a) => fn(a));
    }
  }

  // 3) Simboli/lettere: `\alpha`, `\leftrightarrow`, … Ordino le chiavi dalla
  //    più lunga alla più corta così `\leq` non intercetta `\leftrightarrow`.
  const keys = Object.keys(MATH_SYMBOLS).sort((a, b) => b.length - a.length);
  const symRe = new RegExp(`\\\\(${keys.join('|')})(?![a-zA-Z])`, 'g');
  bump(symRe);
  s = s.replace(symRe, (_, k) => MATH_SYMBOLS[k]);

  // 4) Delimitatori dinamici `\left(` / `\right)`: in Typst basta la parentesi
  //    (la lunga corrisponde automaticamente). Vanno DOPO i simboli, così
  //    `\rightarrow` è già stato convertito e non viene toccato qui.
  bump(/\\left(?![a-zA-Z])/g);
  bump(/\\right(?![a-zA-Z])/g);
  s = s.replace(/\\left(?![a-zA-Z])\s*/g, '').replace(/\\right(?![a-zA-Z])\s*/g, '');

  // 4b) Pedici/apici raggruppati con graffe LaTeX: `x^{2}`, `a_{ij}`. In Typst
  //     le graffe sono un insieme, non un gruppo → si usano le tonde.
  for (let i = 0; i < 3; i++) {
    const re = /([_^])\s*\{([^{}]*)\}/g;
    if (!bump(re)) break;
    s = s.replace(re, '$1($2)');
  }

  // 5) Spaziature LaTeX senza senso in Typst: `\,` `\;` `\!` `\quad` `\qquad`.
  bump(/\\(?:quad|qquad|,|;|:|!)/g);
  s = s
    .replace(/\\qquad/g, ' quad quad ')
    .replace(/\\quad/g, ' quad ')
    .replace(/\\[,;:]/g, ' thin ')
    .replace(/\\!/g, '');

  return { text: s, n };
}

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

function blockRangeAtLine(source, line = 1) {
  const lines = String(source || '').split('\n');
  const target = Math.max(0, Math.min(lines.length - 1, Number(line || 1) - 1));
  let first = target;
  let last = target;
  while (first > 0 && lines[first - 1].trim()) first--;
  while (last + 1 < lines.length && lines[last + 1].trim()) last++;
  let start = 0;
  for (let i = 0; i < first; i++) start += lines[i].length + 1;
  let end = start;
  for (let i = first; i <= last; i++) end += lines[i].length + (i < last ? 1 : 0);
  return { start, end, text: String(source || '').slice(start, end) };
}

/** Delimitatori strutturali realmente sbilanciati nell'intero documento. */
function scanStructuralDelimiters(source) {
  const pairs = { '(': ')', '[': ']', '{': '}' };
  const closing = new Set(Object.values(pairs));
  const stack = [];
  const stray = [];
  let quote = false;
  let raw = false;
  let lineComment = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const prev = source[i - 1];
    if (ch === '\n') {
      lineComment = false;
      continue;
    }
    if (lineComment) continue;
    if (!quote && !raw && ch === '/' && source[i + 1] === '/') {
      lineComment = true;
      i++;
      continue;
    }
    if (prev !== '\\' && ch === '`') {
      raw = !raw;
      continue;
    }
    if (raw) continue;
    if (prev !== '\\' && ch === '"') {
      quote = !quote;
      continue;
    }
    if (quote || prev === '\\') continue;
    if (pairs[ch]) {
      stack.push({ ch, index: i });
    } else if (closing.has(ch)) {
      const expectedOpen = Object.keys(pairs).find((open) => pairs[open] === ch);
      if (stack.at(-1)?.ch === expectedOpen) stack.pop();
      else stray.push({ ch, index: i });
    }
  }
  return { open: stack, stray, pairs };
}

/**
 * Genera riparazioni MINIME per un errore di delimitatore vicino a `line`.
 * Non decide quale applicare: il chiamante deve provarle col compilatore e
 * accettare soltanto quella che rende valido il documento.
 */
export function delimiterRepairCandidates(source, line = 1, maxCandidates = 24) {
  const s = String(source || '');
  const range = blockRangeAtLine(s, line);
  const candidates = [];
  const seen = new Set([s]);
  const add = (fixed, description) => {
    if (!fixed || seen.has(fixed) || candidates.length >= maxCandidates) return;
    seen.add(fixed);
    candidates.push({ fixed, description });
  };

  const structural = scanStructuralDelimiters(s);
  const localOpen = structural.open.filter((item) => item.index >= range.start && item.index <= range.end);
  if (localOpen.length) {
    const suffix = [...localOpen].reverse().map((item) => structural.pairs[item.ch]).join('');
    add(s.slice(0, range.end) + suffix + s.slice(range.end), `chiusi delimitatori mancanti «${suffix}»`);
  }
  for (const item of structural.stray) {
    if (item.index < range.start || item.index > range.end) continue;
    add(s.slice(0, item.index) + '\\' + s.slice(item.index), `protetto delimitatore isolato «${item.ch}»`);
  }

  // Markup enfasi: trasformare `_testo_`/`*testo*` nelle funzioni esplicite
  // elimina ambiguità senza cambiare il testo o lo stile visibile.
  const explicit = range.text
    .replace(/_([^_\n]+)_/g, '#emph[$1]')
    .replace(/\*([^*\n]+)\*/g, '#strong[$1]');
  if (explicit !== range.text) {
    add(s.slice(0, range.start) + explicit + s.slice(range.end), 'enfasi resa esplicita (#emph/#strong)');
  }

  // Delimitatori inline che devono comparire in coppia. Per un numero dispari
  // prova sia la chiusura a fine blocco sia la protezione di ciascun simbolo:
  // sarà il compilatore, non l'euristica, a scegliere l'unica variante valida.
  for (const delimiter of ['_', '*', '$', '`']) {
    const positions = [];
    for (let i = 0; i < range.text.length; i++) {
      if (range.text[i] === delimiter && range.text[i - 1] !== '\\') positions.push(i);
    }
    if (positions.length % 2 === 0) continue;
    add(
      s.slice(0, range.end) + delimiter + s.slice(range.end),
      `aggiunta chiusura «${delimiter}»`,
    );
    for (const relative of positions) {
      const at = range.start + relative;
      add(s.slice(0, at) + '\\' + s.slice(at), `protetto «${delimiter}» isolato`);
    }
  }

  return candidates;
}

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

  // 2b) #set font("X") → #set text(font: "X")  (font non è una funzione set).
  const fontSet = count(/#set\s+font\s*\(/g);
  if (fontSet) {
    s = s.replace(/#set\s+font\s*\(/g, '#set text(font: ');
    changes.push(`${fontSet} "#set font(…)" → "#set text(font: …)"`);
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

  // 5) Comandi di testo LaTeX → markup Typst (fuori dalla matematica).
  //    `\textbf{x}`→`*x*`, `\textit{x}`/`\emph{x}`→`_x_`, `\texttt{x}`→`` `x` ``.
  let textCmd = 0;
  const textRepl = [
    [/\\textbf\s*\{([^{}]*)\}/g, '*$1*'],
    [/\\textit\s*\{([^{}]*)\}/g, '_$1_'],
    [/\\emph\s*\{([^{}]*)\}/g, '_$1_'],
    [/\\texttt\s*\{([^{}]*)\}/g, '`$1`'],
    [/\\textsc\s*\{([^{}]*)\}/g, '$1'],
    [/\\textrm\s*\{([^{}]*)\}/g, '$1'],
  ];
  for (const [re, to] of textRepl) {
    const c = count(re);
    if (c) {
      textCmd += c;
      s = s.replace(re, to);
    }
  }
  if (textCmd) changes.push(`${textCmd} comando/i di testo LaTeX → markup Typst`);

  // 6) Comandi matematici LaTeX → Typst: risolve "eftrightarrow" (da `\l…`
  //    interpretato come escape) e le "unclosed delimiter" da `\left`/`\right`.
  const math = convertLatexMath(s);
  if (math.n) {
    s = math.text;
    changes.push(`${math.n} comando/i matematici LaTeX → Typst`);
  }

  // 7) "unclosed label": `<` seguito da spazio o a fine riga non è un'etichetta
  //    valida → lo si scrive come `\<`. Non tocca `<etichetta>` né `<->` (math).
  const strayLt = count(/(?<![<>-])<(?=\s|$)/gm);
  if (strayLt) {
    s = s.replace(/(?<![<>-])<(?=\s|$)/gm, '\\<');
    changes.push(`${strayLt} carattere "<" problematico protetto (\\<)`);
  }

  return { fixed: s, changes };
}
