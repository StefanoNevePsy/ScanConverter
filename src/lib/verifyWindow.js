/*
  Verifica testuale INCREMENTALE.

  Il confronto testo↔PDF riguarda una coppia precisa: questo sorgente, questo
  PDF. Cambiata una parola, la coppia è un'altra e il vecchio esito non dice
  più niente — per questo si rifà. Ma se la parola cambiata sta a pagina 200,
  le altre trecento pagine hanno sorgente identico, e rileggerle è lavoro
  buttato.

  Qui si isola la parte cambiata, si riestraggono solo le pagine che possono
  contenerla e si riusa il resto della lettura precedente. L'assunzione — «il
  resto è rimasto com'era» — non viene data per buona: si estraggono anche le
  pagine ai BORDI della finestra e si controlla che siano identiche a prima.
  Se non lo sono, la rimpaginazione è andata oltre e si torna alla verifica
  completa. Meglio pagare i secondi che dire «verificato» a vanvera.
*/

const PAGE_MARKER = /^<!--\s*pagina\s+(\d+)\s*-->$/u;

/** Massima estensione di una modifica ancora trattabile in modo incrementale. */
export const MAX_INCREMENTAL_CHARS = 4000;

/**
 * Regione cambiata fra due testi, come intervallo nel testo NUOVO.
 * @returns {{start:number, end:number, oldEnd:number}|null} null se identici
 */
export function changedRegion(oldText, newText) {
  const before = String(oldText || '');
  const after = String(newText || '');
  if (before === after) return null;
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before[start] === after[start]) start++;
  let tail = 0;
  while (
    tail < max - start &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail++;
  }
  return { start, end: after.length - tail, oldEnd: before.length - tail };
}

/** Divide il testo estratto dal PDF nei suoi blocchi di pagina. */
export function splitPdfPages(pdfText) {
  const lines = String(pdfText || '').split('\n');
  const pages = [];
  let current = null;
  for (const line of lines) {
    const marker = line.trim().match(PAGE_MARKER);
    if (marker) {
      current = [];
      pages.push({ page: Number(marker[1]), lines: current });
      continue;
    }
    if (!current) {
      current = [];
      pages.push({ page: 1, lines: current });
    }
    current.push(line);
  }
  return pages.map((entry) => ({ page: entry.page, text: entry.lines.join('\n').trim() }));
}

/** Ricompone il testo estratto a partire dai blocchi di pagina. */
export function joinPdfPages(pages) {
  if (!pages?.length) return '';
  if (pages.length === 1 && pages[0].page === 1) return pages[0].text;
  return pages
    .map((entry) => `<!-- pagina ${entry.page} -->\n\n${entry.text}`)
    .join('\n\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

/**
 * Pagine da rileggere per una modifica che sta in una certa frazione del
 * documento.
 *
 * Il margine è largo di proposito: la corrispondenza fra posizione nel
 * sorgente e numero di pagina deriva (misurato: fino a 15 pagine su 387), e
 * una finestra stretta rischierebbe di non contenere la modifica.
 *
 * @returns {{from:number, to:number}} intervallo 1-based, estremi inclusi
 */
export function windowPages(ratioStart, ratioEnd, pageCount, margin = 0) {
  const pages = Math.max(0, Math.floor(Number(pageCount) || 0));
  if (!pages) return { from: 0, to: 0 };
  const span = Math.max(margin, Math.ceil(pages * 0.06), 6);
  const clamp = (value) => Math.min(pages, Math.max(1, value));
  const first = clamp(Math.floor(Math.min(1, Math.max(0, ratioStart)) * (pages - 1)) + 1);
  const last = clamp(Math.ceil(Math.min(1, Math.max(0, ratioEnd)) * (pages - 1)) + 1);
  return { from: clamp(first - span), to: clamp(last + span) };
}

/**
 * Si può verificare in modo incrementale?
 *
 * @param {object} p
 * @param {string} p.oldSource   sorgente dell'ultima verifica completa
 * @param {string} p.newSource   sorgente attuale
 * @param {string[]} p.pageTexts testo delle pagine dell'ultima verifica
 * @returns {{ok:boolean, reason:string, region?:{start:number,end:number}}}
 */
export function canVerifyIncrementally({ oldSource, newSource, pageTexts }) {
  if (!oldSource || !newSource) return { ok: false, reason: 'nessuna verifica precedente' };
  if (!pageTexts?.length) return { ok: false, reason: 'testo delle pagine non disponibile' };
  const region = changedRegion(oldSource, newSource);
  if (!region) return { ok: false, reason: 'sorgente identico' };
  if (region.end - region.start > MAX_INCREMENTAL_CHARS) {
    return { ok: false, reason: 'modifica troppo ampia' };
  }
  if (region.oldEnd - region.start > MAX_INCREMENTAL_CHARS) {
    return { ok: false, reason: 'modifica troppo ampia' };
  }
  // Il preambolo governa l'intera impaginazione: se cambia lui, non c'è
  // nessuna pagina che si possa dare per invariata.
  const preambleEnd = newSource.indexOf('\n\n');
  const lastDirective = Math.max(
    newSource.lastIndexOf('\n#set '),
    newSource.lastIndexOf('\n#show '),
    newSource.lastIndexOf('\n#let '),
    preambleEnd,
  );
  if (region.start <= lastDirective) return { ok: false, reason: 'modifica nel preambolo' };
  return { ok: true, reason: '', region };
}

/**
 * Legge il testo del PDF per la verifica, riusando quanto possibile.
 *
 * @param {object} p
 * @param {string} p.source     sorgente attuale
 * @param {{source:string, pages:{page:number,text:string}[]}|null} p.previous
 *        lettura dell'ultima verifica completa
 * @param {(pages:number[]|null)=>Promise<string|null>} p.read
 *        legge le pagine chieste (null = tutte) e ne restituisce il testo
 * @param {(detail:string)=>void} [p.onDetail]
 * @returns {Promise<{text:string|null, incremental:boolean}>}
 */
export async function verifyPdfText({ source, previous, read, onDetail }) {
  const check = canVerifyIncrementally({
    oldSource: previous?.source,
    newSource: source,
    pageTexts: previous?.pages,
  });
  if (!check.ok) return { text: await read(null), incremental: false };

  const conteggio = previous.pages.length;
  const { from, to } = windowPages(
    check.region.start / Math.max(1, source.length),
    check.region.end / Math.max(1, source.length),
    conteggio,
  );
  // Una pagina in più per lato: è il CONTROLLO. Se la rimpaginazione è
  // arrivata fin lì, la lettura precedente non è più riusabile.
  const primo = Math.max(1, from - 1);
  const ultimo = Math.min(conteggio, to + 1);
  const numeri = [];
  for (let n = primo; n <= ultimo; n++) numeri.push(n);
  if (numeri.length >= conteggio) return { text: await read(null), incremental: false };

  onDetail?.(`Verifica testuale · ${numeri.length} pagine su ${conteggio}…`);
  const parziale = await read(numeri);
  if (!parziale) return { text: await read(null), incremental: false };

  const lette = new Map(splitPdfPages(parziale).map((entry) => [entry.page, entry.text]));
  const precedenti = new Map(previous.pages.map((entry) => [entry.page, entry.text]));
  const bordi = [primo < from ? primo : null, ultimo > to ? ultimo : null].filter(Boolean);
  for (const bordo of bordi) {
    if (lette.get(bordo) !== precedenti.get(bordo)) {
      return { text: await read(null), incremental: false };
    }
  }

  const unite = previous.pages.map((entry) => ({
    page: entry.page,
    text: lette.has(entry.page) ? lette.get(entry.page) : entry.text,
  }));
  return { text: joinPdfPages(unite), incremental: true };
}
