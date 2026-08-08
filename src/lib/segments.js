/*
  Riparsing dei SEGMENTI a livello di regione (idea ripresa dai parser
  documentali per RAG, es. Chunkr): invece di accontentarsi del testo
  linearizzato che l'OCR produce per una tabella, si ritaglia la regione dalla
  pagina e la si rimanda a un modello multimodale con un prompt dedicato.

  Perché serve: Nemotron-Parse marca il blocco come `Table` e ne dà la bbox, ma
  il `text` è spesso una tabella LaTeX malformata (o righe appiattite) quando la
  scansione è brutta. A valle nessuna conversione testuale può recuperare la
  struttura di righe/colonne che è andata persa: l'informazione c'è solo
  nell'IMMAGINE. Ritagliando la sola tabella, il modello la vede grande e senza
  il rumore del resto della pagina.

  Sicurezza: il modello potrebbe inventare celle. Il risultato è accettato solo
  se supera un guard deterministico a multinsieme di token (`tableGuard`): non
  può introdurre parole o numeri che non fossero già nel blocco originale. Se il
  guard fallisce, il blocco resta ESATTAMENTE com'era.
*/

import { canonicalTokens } from './strict.js';
import { loadImage, cropToDataUrl } from './figures.js';
import { geminiVision } from './gemini.js';

const TABLE_TYPES = new Set(['Table', 'Table-body', 'TableBody', 'Tabella']);

/** Un blocco è una tabella riparsabile se è tipizzato come tale e ha bbox. */
export function isTableBlock(b) {
  return Boolean(b && TABLE_TYPES.has(b.type) && b.bbox);
}

// Parole di controllo LaTeX/Markdown che l'OCR mette nel testo della tabella ma
// che NON sono contenuto: possono sparire dal riparsing senza che sia una
// perdita. Tutto il resto (parole e numeri delle celle) deve essere preservato.
const LATEX_NOISE = new Set([
  'begin', 'end', 'tabular', 'hline', 'cline', 'toprule', 'midrule', 'bottomrule',
  'multicolumn', 'multirow', 'textbf', 'textit', 'emph', 'centering', 'caption',
  'label', 'array', 'cr', 'noalign', 'vspace', 'hspace', 'raggedright', 'arraybackslash',
]);

// Anche la specifica di colonne di `tabular` («ll», «lcr», «p») è sintassi, non
// contenuto: è sempre una sequenza di questi soli caratteri.
const isNoise = (t) => LATEX_NOISE.has(t) || /^[lcrxp]+$/.test(t);

const TABLE_PROMPT =
  'Questa immagine è UNA tabella ritagliata da una pagina scansionata. ' +
  'Trascrivila come tabella Markdown con le pipe, così:\n' +
  '| Intestazione A | Intestazione B |\n| --- | --- |\n| cella | cella |\n\n' +
  'REGOLE FERREE:\n' +
  '- riporta ESATTAMENTE il contenuto delle celle, carattere per carattere: ' +
  'non correggere, non tradurre, non riassumere, non completare;\n' +
  '- NON inventare celle, righe, colonne, numeri o intestazioni: se una cella ' +
  'è vuota lasciala vuota; se un valore è illeggibile trascrivilo come meglio ' +
  'puoi senza sostituirlo con un valore plausibile;\n' +
  '- rispetta il numero di colonne di ogni riga; per le celle unite ripeti il ' +
  'contenuto oppure lascia vuote le colonne restanti;\n' +
  '- se l’immagine NON è una tabella, restituisci il testo così com’è, senza pipe.\n' +
  'Restituisci SOLO la tabella, senza spiegazioni e senza blocchi di codice.';

/** Toglie il recinto ```…``` che alcuni modelli aggiungono comunque. */
export function stripFence(text) {
  const t = String(text || '').trim();
  const m = t.match(/^```[a-zA-Z]*\n([\s\S]*?)\n?```$/);
  return (m ? m[1] : t).trim();
}

/** True se il testo sembra una tabella Markdown con pipe (almeno due righe). */
export function looksLikeMarkdownTable(text) {
  const rows = String(text || '')
    .trim()
    .split('\n')
    .filter((l) => l.includes('|'));
  return rows.length >= 2;
}

/**
 * Guard deterministico: la tabella riparsata è accettabile solo se non
 * INTRODUCE parole/numeri assenti dall'originale. Le parole di controllo LaTeX
 * possono invece sparire (non sono contenuto).
 *
 * @param {string} originalText testo del blocco secondo l'OCR
 * @param {string} refinedText  tabella prodotta dal modello
 * @returns {{ok:boolean, added:string[], missing:string[]}}
 */
export function tableGuard(originalText, refinedText) {
  const count = (tokens) => {
    const map = new Map();
    for (const t of tokens) {
      if (isNoise(t)) continue;
      map.set(t, (map.get(t) || 0) + 1);
    }
    return map;
  };
  const a = count(canonicalTokens(originalText));
  const b = count(canonicalTokens(refinedText));

  const added = [];
  const missing = [];
  for (const [t, n] of b) {
    const delta = n - (a.get(t) || 0);
    for (let i = 0; i < delta && added.length < 20; i++) added.push(t);
  }
  for (const [t, n] of a) {
    const delta = n - (b.get(t) || 0);
    for (let i = 0; i < delta && missing.length < 20; i++) missing.push(t);
  }

  // Nessuna invenzione ammessa; le perdite sono tollerate solo in minima parte
  // (una cella illeggibile resa diversamente), mai la sparizione della tabella.
  const originalSize = [...a.values()].reduce((n, v) => n + v, 0);
  const allowedLoss = Math.max(1, Math.floor(originalSize * 0.1));
  const ok = added.length === 0 && missing.length <= allowedLoss;
  return { ok, added, missing };
}

/**
 * Riparsa le tabelle di UNA pagina ritagliandole e rimandandole al modello
 * multimodale. Non muta i blocchi in ingresso: restituisce un nuovo array in
 * cui i soli blocchi tabella accettati hanno il `text` sostituito.
 *
 * Richiede bbox (quindi il motore OCR NVIDIA) e la chiave Google. In assenza di
 * una delle due, i blocchi tornano invariati senza errori.
 *
 * @param {object} p
 * @param {Array} p.blocks         blocchi della pagina (type, bbox, text)
 * @param {string} p.pageDataUrl   data URL della pagina sorgente
 * @param {object} p.settings
 * @param {number} [p.maxTables]   tetto di richieste per pagina
 * @param {AbortSignal} [p.signal]
 * @param {(done:number,total:number)=>void} [p.onProgress]
 * @returns {Promise<{blocks:Array, refined:number, rejected:number}>}
 */
export async function refinePageTables({
  blocks,
  pageDataUrl,
  settings,
  maxTables = 4,
  signal,
  onProgress,
}) {
  const targets = (blocks || []).filter(isTableBlock).slice(0, maxTables);
  if (!targets.length || !settings?.googleApiKey || !pageDataUrl) {
    return { blocks, refined: 0, rejected: 0 };
  }

  let img;
  try {
    img = await loadImage(pageDataUrl);
  } catch {
    return { blocks, refined: 0, rejected: 0 }; // pagina non disponibile: nessun danno
  }

  const out = [...blocks];
  let refined = 0;
  let rejected = 0;

  for (let i = 0; i < targets.length; i++) {
    if (signal?.aborted) break;
    const block = targets[i];
    onProgress?.(i + 1, targets.length);
    try {
      const crop = cropToDataUrl(img, block.bbox, 0.012);
      const answer = stripFence(
        await geminiVision({
          apiKey: settings.googleApiKey,
          model: settings.geminiOcrModel || settings.geminiModel,
          imageDataUrl: crop,
          prompt: TABLE_PROMPT,
          maxTokens: 4096,
          signal,
        }),
      );
      if (!answer || !looksLikeMarkdownTable(answer)) {
        rejected++;
        continue;
      }
      if (!tableGuard(block.text || '', answer).ok) {
        rejected++;
        continue; // il modello ha inventato o perso contenuto: si tiene l'OCR
      }
      const idx = out.indexOf(block);
      if (idx >= 0) {
        out[idx] = { ...block, text: answer };
        refined++;
      }
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      rejected++; // una tabella fallita non interrompe l'OCR della pagina
    }
  }

  return { blocks: out, refined, rejected };
}
