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
 * Normalizza i livelli di titolo del Markdown OCR: mappa le profondità
 * effettivamente usate su 1..N, così il titolo più esterno diventa sempre
 * `#` (→ `=` in Typst). Applicato all'INTERO documento prima del chunking:
 * garantisce una scala di livelli coerente su tutte le pagine.
 * @param {string} md
 * @returns {string}
 */
export function normalizeHeadingLevels(md) {
  const re = /^(#{1,6})\s+/;
  // La numerazione esplicita è un segnale più affidabile del numero di #
  // prodotto dall'OCR: 2 → livello 1, 2.3 → livello 2, 2.3.1 → livello 3.
  const numbered = md
    .split('\n')
    .map((line) => {
      const m = line.match(re);
      if (!m) return line;
      const title = line.slice(m[0].length);
      const n = title.match(/^\s*(\d+(?:\.\d+){0,5})[.)]?\s+/);
      if (!n) return line;
      const depth = Math.min(6, n[1].split('.').length);
      return '#'.repeat(depth) + ' ' + title;
    })
    .join('\n');
  const depths = new Set();
  for (const line of numbered.split('\n')) {
    const m = line.match(re);
    if (m) depths.add(m[1].length);
  }
  if (depths.size === 0) return numbered;
  const sorted = [...depths].sort((a, b) => a - b);
  const map = new Map(sorted.map((d, i) => [d, i + 1]));
  return numbered
    .split('\n')
    .map((line) => {
      const m = line.match(re);
      if (!m) return line;
      return '#'.repeat(map.get(m[1].length)) + line.slice(m[1].length);
    })
    .join('\n');
}

/**
 * Impone in modo DETERMINISTICO i livelli di titolo del sorgente al corpo
 * Typst prodotto da Gemini: allinea per ordine i titoli del chunk sorgente
 * (livelli Markdown normalizzati) con quelli in output (`=`, `==`, …) e
 * riscrive la profondità. Se il numero di titoli non coincide, lascia
 * l'output invariato (nessun rischio di corruzione). Questa è la garanzia di
 * coerenza gerarchica indipendente dall'LLM.
 * @param {string} body corpo Typst da Gemini
 * @param {string} sourceChunk Markdown sorgente (livelli già normalizzati)
 * @returns {string}
 */
export function enforceHeadingLevels(body, sourceChunk) {
  const srcLevels = [...sourceChunk.matchAll(/^(#{1,6})\s+/gm)].map((m) => m[1].length);
  const lines = body.split('\n');
  const headingIdx = [];
  lines.forEach((l, i) => {
    if (/^=+\s/.test(l.trimStart())) headingIdx.push(i);
  });
  if (headingIdx.length !== srcLevels.length || srcLevels.length === 0) return body;
  headingIdx.forEach((li, k) => {
    const line = lines[li];
    const lead = line.match(/^(\s*)/)[1];
    const rest = line.trimStart().replace(/^=+\s+/, '');
    lines[li] = `${lead}${'='.repeat(srcLevels[k])} ${rest}`;
  });
  return lines.join('\n');
}

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
 * Divide un testo per la visualizzazione conservando gli offset assoluti.
 * A differenza di `chunkDocument` non normalizza righe vuote o spazi: una
 * selezione nel chunk può quindi essere riportata senza ambiguità al testo
 * completo tramite `range.start + selectionStart`.
 */
export function chunkTextRanges(text, maxChars = 6000) {
  const source = String(text || '');
  if (!source.length) return [];
  const limit = Math.max(500, maxChars);
  const ranges = [];
  let start = 0;
  while (start < source.length) {
    let end = Math.min(source.length, start + limit);
    if (end < source.length) {
      const minimum = start + Math.floor(limit * 0.45);
      const paragraph = source.lastIndexOf('\n\n', end);
      if (paragraph >= minimum) {
        end = paragraph + 2;
      } else {
        const window = source.slice(start, end);
        let sentenceEnd = -1;
        for (const match of window.matchAll(/[.!?…][»”’"')\]]?\s+/gu)) {
          sentenceEnd = match.index + match[0].length;
        }
        if (start + sentenceEnd >= minimum) end = start + sentenceEnd;
      }
    }
    if (end <= start) end = Math.min(source.length, start + limit);
    ranges.push({ start, end, text: source.slice(start, end) });
    start = end;
  }
  return ranges;
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

/** Normalizza il testo di un titolo per il confronto (dedup). */
function headingKey(text) {
  return (text || '').toLowerCase().replace(/[.:;,]+$/, '').replace(/\s+/g, ' ').trim();
}

/**
 * Ricompone il documento completo dai corpi dei chunk. Alcuni modelli
 * ri-emettono a inizio chunk la "posizione gerarchica" ricevuta nel prompt
 * come veri titoli (es. ripetono `= Ipotizzazione` già presente): i titoli
 * INIZIALI di un chunk identici all'ultimo titolo visto allo stesso livello
 * vengono scartati.
 * @param {string} preamble
 * @param {string[]} bodies
 * @returns {string}
 */
export function combineDocument(preamble, bodies) {
  const lastAtLevel = []; // ultimo titolo visto per livello (chiave normalizzata)
  const parts = [];
  for (const raw of bodies) {
    if (!raw || !raw.trim()) continue;
    const lines = raw.split('\n');
    let start = 0;
    // Scarta i titoli in testa al chunk che duplicano il percorso corrente.
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (!t) continue;
      const m = t.match(/^(=+)\s+(.+)$/);
      if (!m) break;
      const level = m[1].length;
      if (parts.length && lastAtLevel[level - 1] === headingKey(m[2])) {
        start = i + 1; // duplicato: salta anche le righe vuote precedenti
        continue;
      }
      break;
    }
    const kept = lines.slice(start).join('\n').trim();
    if (!kept) continue;
    // Aggiorna il percorso gerarchico con i titoli del chunk mantenuto.
    for (const line of kept.split('\n')) {
      const m = line.trim().match(/^(=+)\s+(.+)$/);
      if (!m) continue;
      const level = m[1].length;
      lastAtLevel.length = level;
      lastAtLevel[level - 1] = headingKey(m[2]);
    }
    parts.push(kept);
  }
  const body = parts.join('\n\n');
  return preamble ? `${preamble}\n\n${body}` : body;
}
