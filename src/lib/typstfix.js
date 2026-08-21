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
  return {
    start,
    end,
    text: String(source || '').slice(start, end),
    firstLine: first + 1,
    lastLine: last + 1,
  };
}

/** Delimitatori strutturali realmente sbilanciati nell'intero documento. */
function scanStructuralDelimiters(source) {
  const pairs = { '(': ')', '[': ']', '{': '}' };
  const closing = new Set(Object.values(pairs));
  const stack = [];
  const stray = [];
  const mismatched = [];
  let quote = false;
  let rawTicks = 0;
  let lineComment = false;
  let blockComment = 0;
  const escaped = (at) => {
    let slashes = 0;
    for (let j = at - 1; j >= 0 && source[j] === '\\'; j--) slashes++;
    return slashes % 2 === 1;
  };
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '\n') {
      lineComment = false;
      continue;
    }
    if (lineComment) continue;
    if (blockComment) {
      if (ch === '/' && source[i + 1] === '*') {
        blockComment++;
        i++;
      } else if (ch === '*' && source[i + 1] === '/') {
        blockComment--;
        i++;
      }
      continue;
    }
    if (!quote && !rawTicks && ch === '/' && source[i + 1] === '/') {
      lineComment = true;
      i++;
      continue;
    }
    if (!quote && !rawTicks && ch === '/' && source[i + 1] === '*') {
      blockComment = 1;
      i++;
      continue;
    }
    if (ch === '`' && !escaped(i)) {
      let count = 1;
      while (source[i + count] === '`') count++;
      if (!rawTicks) rawTicks = count;
      else if (count === rawTicks) rawTicks = 0;
      i += count - 1;
      continue;
    }
    if (rawTicks) continue;
    if (!escaped(i) && ch === '"') {
      quote = !quote;
      continue;
    }
    if (quote || escaped(i)) continue;
    if (pairs[ch]) {
      stack.push({ ch, index: i });
    } else if (closing.has(ch)) {
      const top = stack.at(-1);
      if (top && pairs[top.ch] === ch) {
        stack.pop();
        continue;
      }
      // Se la chiusura corrisponde a un'apertura più in basso nello stack,
      // mancano i delimitatori degli elementi annidati: proponi di inserirli
      // subito prima. Esempio `([testo)` → `([testo])`.
      let matching = -1;
      for (let j = stack.length - 1; j >= 0; j--) {
        if (pairs[stack[j].ch] === ch) {
          matching = j;
          break;
        }
      }
      if (matching >= 0) {
        const missing = stack.slice(matching + 1).reverse().map((item) => pairs[item.ch]).join('');
        mismatched.push({ ch, index: i, missing, expected: pairs[top.ch] });
        stack.splice(matching);
      } else if (top) {
        // Non esiste alcuna apertura compatibile: spesso l'LLM ha usato il
        // tipo di parentesi sbagliato (`#emph[testo)`). La sostituzione viene
        // comunque convalidata dal compilatore prima di essere accettata.
        mismatched.push({ ch, index: i, missing: '', expected: pairs[top.ch] });
        stack.pop();
      } else {
        stray.push({ ch, index: i });
      }
    }
  }
  return { open: stack, stray, mismatched, pairs };
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
  for (const item of structural.mismatched) {
    if (item.index < range.start || item.index > range.end) continue;
    if (item.missing) {
      add(
        s.slice(0, item.index) + item.missing + s.slice(item.index),
        `inserita chiusura mancante «${item.missing}»`,
      );
    }
    if (item.expected && item.expected !== item.ch) {
      add(
        s.slice(0, item.index) + item.expected + s.slice(item.index + 1),
        `corretto delimitatore «${item.ch}» → «${item.expected}»`,
      );
    }
  }
  const localOpen = structural.open.filter((item) => item.index >= range.start && item.index <= range.end);
  if (localOpen.length) {
    const suffix = [...localOpen].reverse().map((item) => structural.pairs[item.ch]).join('');
    add(s.slice(0, range.end) + suffix + s.slice(range.end), `chiusi delimitatori mancanti «${suffix}»`);
  }
  for (const item of structural.stray) {
    if (item.index < range.start || item.index > range.end) continue;
    add(s.slice(0, item.index) + '\\' + s.slice(item.index), `protetto delimitatore isolato «${item.ch}»`);
    add(s.slice(0, item.index) + s.slice(item.index + 1), `rimosso delimitatore isolato «${item.ch}»`);
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
      if (range.text[i] !== delimiter) continue;
      let slashes = 0;
      for (let j = i - 1; j >= 0 && range.text[j] === '\\'; j--) slashes++;

      // Un LLM può raddoppiare l'escape di un marcatore letterale:
      // `\\*` non protegge l'asterisco in Typst, perché i due backslash si
      // proteggono fra loro e `*` torna ad aprire il grassetto. Prova prima
      // la riparazione semanticamente conservativa `\*`; il compilatore la
      // convalida come ogni altro candidato.
      if (slashes >= 2 && slashes % 2 === 0) {
        const at = range.start + i;
        add(
          s.slice(0, at - 1) + s.slice(at),
          `normalizzato escape raddoppiato prima di «${delimiter}»`,
        );
      }

      // Conta il marcatore come attivo solo con un numero pari di backslash.
      // Il vecchio controllo guardava unicamente il carattere precedente e
      // scambiava proprio `\\*` per un asterisco già protetto.
      if (slashes % 2 === 0) positions.push(i);
    }
    if (positions.length % 2 === 0) continue;

    // Un marcatore isolato sul bordo del blocco è quasi sempre un richiamo
    // letterale (per esempio l'asterisco di una nota dopo un titolo). Chiuderlo
    // sullo stesso bordo produrrebbe `**`/`__`: compila, ma crea markup vuoto
    // e può lasciare un warning. La protezione conserva invece il carattere.
    for (const relative of positions) {
      if (relative !== 0 && relative !== range.text.length - 1) continue;
      const at = range.start + relative;
      add(s.slice(0, at) + '\\' + s.slice(at), `protetto «${delimiter}» isolato sul bordo`);
    }

    // Se il marcatore è in mezzo alla prosa ma non ha una coppia, rimuoverlo
    // conserva tutte le parole e rinuncia soltanto a uno stile ormai
    // indeterminabile. È più prudente che enfatizzare fino alla fine di un
    // paragrafo potenzialmente molto lungo.
    for (const relative of positions) {
      if (relative === 0 || relative === range.text.length - 1) continue;
      const at = range.start + relative;
      add(
        s.slice(0, at) + s.slice(at + 1),
        `rimosso «${delimiter}» senza coppia`,
      );
    }
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

const UNKNOWN_IDENTIFIER_MAP = {
  paragraph: 'par',
  textbf: 'strong',
  textit: 'emph',
  bold: 'strong',
  italic: 'emph',
  italics: 'emph',
  includegraphics: 'image',
  img: 'image',
  href: 'link',
  newpage: 'pagebreak',
  new_page: 'pagebreak',
  page_break: 'pagebreak',
  newline: 'linebreak',
  new_line: 'linebreak',
  line_break: 'linebreak',
  hspace: 'h',
  vspace: 'v',
};

const UNKNOWN_ARGUMENT_MAP = {
  top: 'above',
  bottom: 'below',
  fontsize: 'size',
  'font-size': 'size',
  fontweight: 'weight',
  'font-weight': 'weight',
  fontstyle: 'style',
  'font-style': 'style',
  color: 'fill',
  background: 'fill',
  padding: 'inset',
  lineheight: 'leading',
  'line-height': 'leading',
  'line-spacing': 'leading',
};

function escapeTypstContent(text) {
  return String(text || '')
    .replace(/\\/g, '\\\\')
    .replace(/([#$@\[\]])/g, '\\$1')
    .replace(/</g, '\\<')
    .replace(/>/g, '\\>');
}

function replaceLocalMatches(source, range, re, replacement, add, description) {
  const local = source.slice(range.start, range.end);
  for (const match of local.matchAll(re)) {
    const at = range.start + match.index;
    const before = source.slice(at, at + match[0].length);
    const after = typeof replacement === 'function' ? replacement(...match) : replacement;
    if (before === after) continue;
    add(source.slice(0, at) + after + source.slice(at + before.length), description);
  }
}

function primaryError(result) {
  return result?.diagnostics?.find((diag) => diag.severity === 'error') || result?.diagnostics?.[0] || null;
}

function errorCount(result) {
  return result?.diagnostics?.filter((diag) => diag.severity === 'error').length || 0;
}

function warningCount(result) {
  return result?.diagnostics?.filter((diag) => diag.severity === 'warning').length || 0;
}

// Per gli errori di delimitatore una patch può cambiare soltanto sintassi:
// parentesi, marker inline ed escape. Se cambia qualunque altro carattere,
// non è più una riparazione conservativa e non viene nemmeno compilata.
function delimiterTextFingerprint(source) {
  return String(source || '').replace(/[\\_*\$`[\]{}()]/g, '');
}

function errorFamily(message) {
  const text = String(message || '').toLowerCase();
  if (/delimiter|unclosed|unterminated|closing/.test(text)) return 'delimiter';
  if (/unknown (?:variable|function|argument)/.test(text)) return 'unknown';
  if (/expected|unexpected|invalid character|not valid in code/.test(text)) return 'syntax';
  return text.replace(/[`“”'"].*?[`“”'"]/g, '').replace(/\d+/g, '#').slice(0, 80);
}

/** Una patch locale è conservata solo se il compilatore prova un avanzamento. */
export function diagnosticProgress(before, after) {
  if (after?.ok) return true;
  const previous = primaryError(before);
  const next = primaryError(after);
  if (!previous || !next) return false;
  const previousLine = Number(previous.line || 0);
  const nextLine = Number(next.line || 0);
  if (previousLine && nextLine && nextLine > previousLine) return true;
  if (
    errorCount(after) < errorCount(before) &&
    (!previousLine || !nextLine || nextLine >= previousLine)
  ) return true;
  return (
    errorFamily(previous.message) !== errorFamily(next.message) &&
    (!previousLine || !nextLine || nextLine >= previousLine)
  );
}

/**
 * Candidati locali guidati dal messaggio del compilatore. Oltre ai
 * delimitatori copre alias LaTeX/HTML e nomi tipici inventati dagli LLM.
 */
export function typstRepairCandidates(source, diagnostic = {}, maxCandidates = 16) {
  const s = String(source || '');
  const line = Math.max(1, Number(diagnostic?.line || 1));
  const candidates = [];
  const seen = new Set([s]);
  const add = (fixed, description) => {
    if (!fixed || seen.has(fixed) || candidates.length >= maxCandidates) return;
    seen.add(fixed);
    candidates.push({ fixed, description });
  };

  // Il parser può segnalare l'errore all'inizio del blocco successivo quando
  // la vera apertura è nel paragrafo precedente: prova entrambi.
  for (const candidateLine of new Set([line, Math.max(1, line - 1)])) {
    for (const candidate of delimiterRepairCandidates(s, candidateLine, maxCandidates)) {
      add(candidate.fixed, candidate.description);
    }
  }

  const range = blockRangeAtLine(s, line);
  const message = String(diagnostic?.message || '');
  const unknown = message.match(/unknown (?:variable|function):?\s*[`“”'"]?([\w-]+)/i)?.[1];
  const identifier = UNKNOWN_IDENTIFIER_MAP[unknown];
  if (identifier) {
    const escaped = unknown.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    replaceLocalMatches(
      s,
      range,
      new RegExp(`#${escaped}(?=\\s*[\\[(])`, 'g'),
      `#${identifier}`,
      add,
      `funzione «${unknown}» → «${identifier}»`,
    );
    replaceLocalMatches(
      s,
      range,
      new RegExp(`(#(?:set|show)\\s+)${escaped}\\b`, 'g'),
      (whole, prefix) => `${prefix}${identifier}`,
      add,
      `regola «${unknown}» → «${identifier}»`,
    );
  }

  const unknownArg = message.match(/unknown argument:?\s*[`“”'"]?([\w-]+)/i)?.[1];
  const argument = UNKNOWN_ARGUMENT_MAP[unknownArg];
  if (argument) {
    const escaped = unknownArg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    replaceLocalMatches(
      s,
      range,
      new RegExp(`\\b${escaped}(?=\\s*:)`, 'g'),
      argument,
      add,
      `argomento «${unknownArg}» → «${argument}»`,
    );
  }

  // Virgolette tipografiche usate per errore come stringhe dentro una
  // chiamata. La prosa normale non viene toccata.
  replaceLocalMatches(
    s,
    range,
    /([(:,=]\s*)[“‘]([^”’\n]+)[”’]/g,
    (whole, prefix, text) => `${prefix}"${text}"`,
    add,
    'virgolette tipografiche → stringa Typst',
  );

  const html = [
    [/<sup>([^<\n]*)<\/sup>/gi, (whole, text) => `#super[${escapeTypstContent(text)}]`, 'HTML <sup> → #super'],
    [/<sub>([^<\n]*)<\/sub>/gi, (whole, text) => `#sub[${escapeTypstContent(text)}]`, 'HTML <sub> → #sub'],
    [/<(?:strong|b)>([^<\n]*)<\/(?:strong|b)>/gi, (whole, text) => `#strong[${escapeTypstContent(text)}]`, 'HTML grassetto → #strong'],
    [/<(?:em|i)>([^<\n]*)<\/(?:em|i)>/gi, (whole, text) => `#emph[${escapeTypstContent(text)}]`, 'HTML corsivo → #emph'],
    [/<br\s*\/?>/gi, '#linebreak()', 'HTML <br> → #linebreak'],
  ];
  for (const [pattern, replacement, description] of html) {
    replaceLocalMatches(s, range, pattern, replacement, add, description);
  }

  // Assegnazioni in stile Python/CSS dentro chiamate (`width = 80%`). Non
  // toccare i `#let x = ...`: il candidato è sempre verificato localmente.
  if (/expected.*:|named argument|argument/i.test(message)) {
    replaceLocalMatches(
      s,
      range,
      /\b(?!let\b)([a-z][\w-]*)\s*=\s*(?=[^=])/g,
      (whole, name) => `${name}: `,
      add,
      'argomento con «=» → «:»',
    );
  }

  return candidates;
}

/**
 * Motore iterativo locale. Può attraversare decine di errori consecutivi e
 * non conserva mai una patch euristica senza una prova di avanzamento del
 * compilatore.
 */
export async function repairTypstDeterministically({
  source,
  diagnose,
  maxRounds = 64,
  maxCandidates = 16,
  maxAttempts = 256,
  signal,
}) {
  const abortIfNeeded = () => {
    if (!signal?.aborted) return;
    const error = new Error('Correzione annullata.');
    error.name = 'AbortError';
    throw error;
  };
  abortIfNeeded();
  const initial = autofixTypst(String(source || ''));
  let code = initial.fixed;
  const changes = [...initial.changes];
  const visited = new Set([code]);
  let result = await diagnose(code);
  let rounds = 0;
  let attempts = 0;

  while (!result?.ok && rounds < maxRounds && attempts < maxAttempts) {
    abortIfNeeded();
    const diagnostic = primaryError(result) || {};
    const candidates = typstRepairCandidates(code, diagnostic, maxCandidates);
    let progressed = null;
    let warningFallback = null;
    const delimiterFingerprint = errorFamily(diagnostic.message) === 'delimiter'
      ? delimiterTextFingerprint(code)
      : null;
    for (const candidate of candidates) {
      abortIfNeeded();
      if (attempts >= maxAttempts) break;
      if (
        delimiterFingerprint != null &&
        delimiterTextFingerprint(candidate.fixed) !== delimiterFingerprint
      ) continue;
      if (visited.has(candidate.fixed)) continue;
      visited.add(candidate.fixed);
      attempts++;
      const checked = await diagnose(candidate.fixed);
      if (diagnosticProgress(result, checked)) {
        const choice = { ...candidate, checked };
        if (checked?.ok) {
          const warnings = warningCount(checked);
          if (!warnings) {
            progressed = choice;
            break;
          }
          if (!warningFallback || warnings < warningCount(warningFallback.checked)) {
            warningFallback = choice;
          }
          // Un risultato valido ma con warning non chiude subito la ricerca:
          // prova gli altri candidati locali per trovare una compilazione pulita.
          continue;
        }
        // Conserva il comportamento veloce per gli avanzamenti intermedi:
        // al prossimo round il compilatore indicherà il nuovo errore primario.
        if (!warningFallback) {
          progressed = choice;
          break;
        }
      }
    }
    if (!progressed) progressed = warningFallback;
    if (!progressed) break;
    code = progressed.fixed;
    result = progressed.checked;
    changes.push(progressed.description);
    rounds++;
  }

  return {
    fixed: code,
    changes,
    ok: result?.ok === true,
    diagnostics: result?.diagnostics || [],
    error: result?.error || '',
    rounds,
    attempts,
  };
}

/**
 * @param {string} source
 * @returns {{ fixed: string, changes: string[] }}
 */
export function autofixTypst(source) {
  let s = source;
  const changes = [];
  const count = (re) => (s.match(re) || []).length;

  // Markdown grassetto residuo: Typst usa un solo `*` per lato. Le forme a
  // doppio delimitatore possono confondere il parser nei chunk prodotti da
  // modelli abituati al Markdown.
  const mdStrong = count(/\*\*[^*\n]+\*\*/g);
  if (mdStrong) {
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '*$1*');
    changes.push(`${mdStrong} grassetto/i Markdown → Typst`);
  }

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
