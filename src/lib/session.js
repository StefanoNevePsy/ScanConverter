/*
  Sessione di elaborazione a chunk con continuità della gerarchia.

  Per documenti grandi (o in caso di rate limiting) il testo OCR viene diviso
  in chunk elaborati da Gemini uno alla volta:
    - il PRIMO chunk genera il preambolo Typst (#set/#show) + il corpo;
    - i chunk successivi ricevono il preambolo (da NON ripetere) e la
      "posizione gerarchica" corrente, e restituiscono SOLO il corpo, coerente
      con i livelli di titolo. Così la gerarchia si mantiene tra le fasi.
  Se un chunk fallisce (429/refuso di rete), i chunk già completati restano e
  la sessione può essere ripresa.
*/

/**
 * Divide il Markdown OCR in chunk non più lunghi di `maxChars`, rispettando i
 * confini di pagina (`<!-- pagina N -->`) e di paragrafo.
 * @param {string} markdown
 * @param {number} maxChars
 * @returns {string[]}
 */
export function chunkDocument(markdown, maxChars = 5000) {
  const text = markdown.trim();
  if (text.length <= maxChars) return [text];

  // Unità atomiche: paragrafi (i marcatori di pagina restano come confini).
  const paras = text.split(/\n\n+/);
  const chunks = [];
  let cur = '';
  for (const para of paras) {
    if (cur && cur.length + para.length + 2 > maxChars) {
      chunks.push(cur);
      cur = '';
    }
    // Paragrafo singolo più grande del limite: spezzalo per frasi.
    if (para.length > maxChars) {
      if (cur) {
        chunks.push(cur);
        cur = '';
      }
      const sentences = para.split(/(?<=[.!?])\s+/);
      let s = '';
      for (const sent of sentences) {
        if (s && s.length + sent.length + 1 > maxChars) {
          chunks.push(s);
          s = '';
        }
        s += (s ? ' ' : '') + sent;
      }
      if (s) cur = s;
    } else {
      cur += (cur ? '\n\n' : '') + para;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/**
 * Separa il preambolo Typst (righe prima del primo titolo `=`) dal corpo.
 * @param {string} typst
 * @returns {{preamble:string, body:string}}
 */
export function splitPreamble(typst) {
  const lines = typst.split('\n');
  const idx = lines.findIndex((l) => /^=+\s/.test(l.trimStart()));
  if (idx === -1) return { preamble: '', body: typst.trim() };
  return {
    preamble: lines.slice(0, idx).join('\n').trim(),
    body: lines.slice(idx).join('\n').trim(),
  };
}

/**
 * Ricava la "posizione gerarchica" corrente da un corpo Typst: l'ultimo
 * titolo visto a ciascun livello, dal più esterno fino al più profondo
 * attuale (uno stack di intestazioni).
 * @param {string} body
 * @returns {string} righe di titolo che rappresentano il percorso corrente
 */
export function outlineFromBody(body) {
  const stack = [];
  const re = /^(=+)\s+(.*)$/;
  for (const raw of body.split('\n')) {
    const m = raw.trimStart().match(re);
    if (!m) continue;
    const depth = m[1].length; // 1 = '=', 2 = '==', ...
    stack.length = depth - 1; // tronca i livelli più profondi
    stack[depth - 1] = `${m[1]} ${m[2]}`;
  }
  return stack.filter(Boolean).join('\n');
}

/**
 * Ricompone il documento completo dai corpi dei chunk.
 * @param {string} preamble
 * @param {string[]} bodies
 * @returns {string}
 */
export function combineDocument(preamble, bodies) {
  const body = bodies.filter((b) => b && b.trim()).join('\n\n');
  return preamble ? `${preamble}\n\n${body}` : body;
}
