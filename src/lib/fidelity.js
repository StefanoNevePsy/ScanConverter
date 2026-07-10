/*
  Verifica DETERMINISTICA della fedeltà testuale della fase 2 (testo OCR →
  Typst). Il testo sorgente è noto, quindi non serve fidarsi dell'LLM: si
  controlla che ogni frase del sorgente compaia nell'output.

  Tecnica: confronto per "shingle" di parole (trigrammi) su testo normalizzato
  (senza markup, accenti, punteggiatura). È robusta alla riformattazione — il
  modello può spostare una nota in `#footnote[...]`, cambiare virgolette o
  sciogliere le sillabazioni — ma un passaggio OMESSO fa crollare la copertura
  della sua frase, che viene segnalata (e ri-richiesta) testualmente.

  Un contatore di caratteri non basterebbe: la riformattazione cambia i
  conteggi e non localizza COSA manca; qui invece ogni frase è verificata.
*/

/** Normalizza per il confronto: minuscole, senza accenti né simboli. */
function normalize(s) {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '') // rimuove i diacritici (perché → perche)
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Rimuove dal Markdown sorgente ciò che non è "testo da preservare". */
function stripSourceMarkup(md) {
  return md
    .replace(/<!--[\s\S]*?-->/g, ' ') // marcatori di pagina
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, ' $1 ') // figure: resta la didascalia
    .replace(/^#{1,6}[ \t]+/gm, '') // marcatori di titolo
    .replace(/\\begin\{[^}]*\}|\\end\{[^}]*\}/g, ' '); // involucri LaTeX
}

/** Parole normalizzate di un testo. */
function words(s) {
  const n = normalize(s);
  return n ? n.split(' ') : [];
}

/** Insieme dei trigrammi di parole di un testo. */
function shingleSet(ws) {
  const set = new Set();
  for (let i = 0; i + 2 < ws.length; i++) {
    set.add(`${ws[i]} ${ws[i + 1]} ${ws[i + 2]}`);
  }
  return set;
}

/**
 * Divide il sorgente in frasi "pesabili", accorpando i frammenti brevi al
 * vicino così ogni unità ha abbastanza shingle per un confronto affidabile.
 */
function splitSentences(text) {
  const rough = text
    .split(/(?<=[.!?…])\s+|\n{2,}/)
    .map((s) => s.trim())
    .filter(Boolean);
  const merged = [];
  for (const frag of rough) {
    if (merged.length && words(merged[merged.length - 1]).length < 8) {
      merged[merged.length - 1] += ' ' + frag;
    } else {
      merged.push(frag);
    }
  }
  return merged;
}

/**
 * Verifica quanta parte del testo sorgente compare nell'output Typst.
 *
 * @param {string} sourceMd  chunk Markdown dell'OCR
 * @param {string} typstBody corpo Typst generato
 * @returns {{coverage:number, missing:string[]}} copertura pesata sui
 *   caratteri (0–1) e frasi del sorgente assenti dall'output (testo
 *   originale, per il re-prompt e per l'utente)
 */
export function checkFidelity(sourceMd, typstBody) {
  const source = stripSourceMarkup(sourceMd);
  const hay = shingleSet(words(typstBody));

  const sentences = splitSentences(source);
  let total = 0;
  let covered = 0;
  const missing = [];

  for (const sentence of sentences) {
    const ws = words(sentence);
    if (ws.length < 4) continue; // troppo corta per pesare nel confronto
    const shingles = [...shingleSet(ws)];
    if (!shingles.length) continue;
    const hit = shingles.filter((sh) => hay.has(sh)).length / shingles.length;
    const weight = ws.length;
    total += weight;
    if (hit >= 0.55) {
      covered += weight;
    } else {
      missing.push(sentence.replace(/\s+/g, ' ').trim());
    }
  }

  return {
    coverage: total ? covered / total : 1,
    missing,
  };
}

/**
 * Istruzione correttiva per il re-prompt: elenca i passaggi omessi.
 * @param {string[]} missing
 * @returns {string}
 */
export function fidelityNoteFrom(missing) {
  const items = missing.slice(0, 6).map((m) => `- «${m.slice(0, 180)}${m.length > 180 ? '…' : ''}»`);
  return (
    'CORREZIONE OBBLIGATORIA: nella conversione precedente i seguenti ' +
    'passaggi del testo sorgente erano stati OMESSI. Questa volta includili ' +
    'TUTTI, integralmente e nella posizione corretta (è vietato riassumere):\n' +
    items.join('\n')
  );
}
