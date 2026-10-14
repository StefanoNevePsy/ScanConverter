/*
  Pulizie che si vedono solo guardando il LIBRO intero, non la pagina.

  L'OCR lavora una pagina alla volta: non può sapere che «3. DALLA TEORIA
  ALLA PRATICA» in cima a ogni pagina è la testatina corrente e non un
  titolo, né che «CAPITOLO», «3» e «Dalla teoria alla pratica» — tre blocchi
  separati nella pagina d'apertura — sono un titolo solo. Sul testo
  completo, con i segni di pagina, entrambe le cose sono evidenti.
*/

const PAGE_RE = /^<!--\s*pagina\s+(\d+)\s*-->\s*$/i;

const keyOf = (text) =>
  String(text || '')
    .replace(/^#{1,6}\s+/, '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}]+/gu, ' ')
    .trim();

/** Divide il Markdown in pagine (marcatore + blocchi). */
function splitPages(markdown) {
  const pages = [];
  let current = { marker: null, blocks: [] };
  for (const raw of String(markdown || '').split(/\n{2,}/)) {
    const lines = raw.split('\n');
    // Il segno di pagina può stare da solo o in testa al primo blocco.
    if (PAGE_RE.test(lines[0].trim())) {
      if (current.marker !== null || current.blocks.length) pages.push(current);
      current = { marker: lines[0], blocks: [] };
      const rest = lines.slice(1).join('\n').trim();
      if (rest) current.blocks.push(rest);
    } else {
      current.blocks.push(raw);
    }
  }
  pages.push(current);
  return pages;
}

function joinPages(pages) {
  const out = [];
  for (const p of pages) {
    if (p.marker !== null) {
      if (p.blocks.length) out.push(`${p.marker}\n${p.blocks[0]}`, ...p.blocks.slice(1));
      else out.push(p.marker);
    } else out.push(...p.blocks);
  }
  return out.join('\n\n');
}

/**
 * Testatine e piedini correnti: una riga breve che compare in cima (o in
 * fondo) a molte pagine con lo stesso testo — al netto del numero di pagina
 * — non è contenuto. Si toglie solo in quella posizione.
 */
export function removeRepeatedRunningHeads(markdown) {
  const pages = splitPages(markdown);
  if (pages.length < 4) return { text: markdown, removed: 0 };
  const counts = new Map();
  const edgeKeys = (p) => {
    const keys = new Set();
    for (const b of [...p.blocks.slice(0, 2), ...p.blocks.slice(-1)]) {
      const k = keyOf(b);
      if (k && k.length <= 90 && !b.includes('\n')) keys.add(k);
    }
    return keys;
  };
  for (const p of pages) for (const k of edgeKeys(p)) counts.set(k, (counts.get(k) || 0) + 1);
    // Una testatina sta su quasi tutte le pagine; un titolo vero che capita in
  // cima (es. «Spunti per il conduttore», ripetuto a ogni abilità) no.
  const threshold = Math.max(3, Math.ceil(pages.length * 0.5));
  const running = new Set([...counts].filter(([, n]) => n >= threshold).map(([k]) => k));
  // La testatina riporta quasi sempre il titolo del capitolo («3. DALLA
  // TEORIA ALLA PRATICA» sopra «Capitolo 3 – Dalla teoria alla pratica»):
  // anche se compare su poche pagine, in cima alla pagina è una testatina.
  const chapterKeys = [];
  for (const p of pages) {
    for (const b of p.blocks) {
      if (/^#\s/.test(b) || CHAPTER_HEADING.test(b)) chapterKeys.push(keyOf(b));
    }
  }
  const isChapterEcho = (b, index) => {
    const k = keyOf(b);
    if (k.length < 10 || b.includes('\n')) return false;
    return chapterKeys.some((ck) => ck !== k && ck.includes(k)) && index === 0;
  };
  for (const p of pages) {
    if (p.blocks.length > 1 && isChapterEcho(p.blocks[0], 0)) running.add(keyOf(p.blocks[0]));
  }
  if (!running.size) return { text: markdown, removed: 0 };
  let removed = 0;
  for (const p of pages) {
    const isRunning = (b) => running.has(keyOf(b)) && !b.includes('\n');
    while (p.blocks.length && isRunning(p.blocks[0])) {
      p.blocks.shift();
      removed++;
    }
    if (p.blocks.length > 1 && isRunning(p.blocks[1]) && /^\d{1,4}$/.test(keyOf(p.blocks[0]) || p.blocks[0].trim())) {
      p.blocks.splice(1, 1);
      removed++;
    }
    while (p.blocks.length && isRunning(p.blocks[p.blocks.length - 1])) {
      p.blocks.pop();
      removed++;
    }
  }
  return { text: joinPages(pages), removed };
}

const CHAPTER_HEADING = /^#{1,6}\s+(?:capitolo|chapter)\s/i;
const CHAPTER_WORD = /^(<!--\s*pagina\s+\d+\s*-->\n)?(?:#{1,6}\s+)?(capitolo|chapter|parte|part)\s*$/i;
const CHAPTER_NUM = /^(?:#{1,6}\s+)?(\d{1,3}|[IVXLC]{1,6})\s*$/;

/**
 * Apertura di capitolo spezzata: «CAPITOLO» / «3» / «Dalla teoria alla
 * pratica» diventano un titolo solo, «# Capitolo 3 – Dalla teoria alla
 * pratica». Le parole restano le stesse; cambia solo come stanno insieme.
 */
export function mergeChapterOpeners(markdown) {
  const blocks = String(markdown || '').split(/\n{2,}/);
  const out = [];
  let merged = 0;
  for (let i = 0; i < blocks.length; i++) {
    const word = blocks[i].trim().match(CHAPTER_WORD);
    const num = blocks[i + 1]?.trim().match(CHAPTER_NUM);
    if (word && num) {
      const label = word[2][0].toUpperCase() + word[2].slice(1).toLowerCase();
      const titleBlock = blocks[i + 2]?.trim() || '';
      const title = titleBlock.replace(/^#{1,6}\s+/, '').replace(/\n/g, ' ').trim();
      // Il titolo vero è breve e non è un paragrafo.
      const hasTitle = title && title.length <= 120 && !/[.;:]$/.test(title) && !PAGE_RE.test(titleBlock);
      out.push(`${word[1] || ''}# ${label} ${num[1]}${hasTitle ? ` – ${title}` : ''}`);
      i += hasTitle ? 2 : 1;
      merged++;
      continue;
    }
    out.push(blocks[i]);
  }
  return { text: out.join('\n\n'), merged };
}

/** Tutte le pulizie a livello di libro, nell'ordine giusto. */
export function cleanupBook(markdown) {
  // Prima si ricompone il titolo di capitolo: serve a riconoscere la
  // testatina che lo ripete.
  const chapters = mergeChapterOpeners(markdown);
  const heads = removeRepeatedRunningHeads(chapters.text);
  return { text: heads.text, removedHeads: heads.removed, mergedChapters: chapters.merged };
}
