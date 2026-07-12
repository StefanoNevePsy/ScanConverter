/*
  Persistenza locale delle configurazioni (chiavi API ed endpoint).
  Le chiavi restano SOLO nel localStorage del browser dell'utente: non
  vengono mai inviate a nessun server tranne le due API ufficiali chiamate
  direttamente dal client.
*/

const KEYS = {
  nvidia: 'sc.nvidiaApiKey',
  google: 'sc.googleApiKey',
  nvidiaEndpoint: 'sc.nvidiaEndpoint',
  nvidiaModel: 'sc.nvidiaModel',
  geminiModel: 'sc.geminiModel',
  geminiOcrModel: 'sc.geminiOcrModel',
  geminiTypstModel: 'sc.geminiTypstModel',
  ocrEngine: 'sc.ocrEngine',
  typstEngine: 'sc.typstEngine',
  nvidiaTypstModel: 'sc.nvidiaTypstModel',
  fixEngine: 'sc.fixEngine',
  fixModel: 'sc.fixModel',
  pdfTextMode: 'sc.pdfTextMode',
  maxPages: 'sc.maxPages',
  chunkSize: 'sc.chunkSize',
  fixTypos: 'sc.fixTypos',
  ocrLongSide: 'sc.ocrLongSide',
  formatWorkflow: 'sc.formatWorkflow',
  compareOcr: 'sc.compareOcr',
};

export const DEFAULTS = {
  // Endpoint hosted verificato: il NIM Nemotron-Parse risponde qui (stile
  // OpenAI chat/completions). Il vecchio ai.api.nvidia.com/gr/... dava 404.
  nvidiaEndpoint: 'https://integrate.api.nvidia.com/v1/chat/completions',
  nvidiaModel: 'nvidia/nemotron-parse',
  geminiOcrModel: 'gemini-flash-latest',
  geminiTypstModel: 'gemini-flash-latest',
  // Motore OCR (fase 1, immagine → testo): 'nvidia' (Nemotron-Parse, estrae
  // anche figure/bbox) oppure 'gemini' (multimodale: più robusto su scansioni
  // pessime e usabile da web, ma senza figure).
  ocrEngine: 'nvidia',
  // Motore per la fase 2 (testo OCR → Typst): 'gemini' oppure 'nvidia'.
  typstEngine: 'gemini',
  // Modello NVIDIA usato quando typstEngine === 'nvidia' (istruct generico,
  // adatto alla generazione di codice).
  nvidiaTypstModel: 'meta/llama-3.3-70b-instruct',
  // Correzione AI degli errori di compilazione: motore e modello dedicati
  // (un modello "forte" da codice; la chiave NVIDIA c'è sempre, serve all'OCR).
  fixEngine: 'nvidia',
  fixModel: 'z-ai/glm-5.2',
  // Ingestione dei PDF con layer di testo (vettoriali / già OCR'd):
  //  'auto' → usa il testo del PDF quando c'è, saltando l'OCR NVIDIA;
  //  'ocr'  → rasterizza sempre e passa da Nemotron-Parse (per estrarre figure).
  pdfTextMode: 'auto',
  maxPages: 20, // pagine PDF per singolo caricamento
  chunkSize: 5000, // caratteri per chunk inviato a Gemini
  // Correzione conservativa dei refusi OCR (accenti, parole saltate,
  // virgolette) durante la strutturazione in Typst. Attiva di default: usa il
  // contesto di frase che il dizionario per-parola non ha.
  fixTypos: true,
  // Lato lungo (px) di rasterizzazione dei PDF per l'OCR. Più alto = più
  // accurato su scansioni pessime, ma payload/tempi maggiori. 2600 ≈ 320 DPI.
  ocrLongSide: 2600,
  // 'legacy': conversione completa tramite LLM; 'strict': testo immutabile,
  // renderer Typst deterministico e verifiche bloccanti.
  formatWorkflow: 'legacy',
  compareOcr: false,
};

// Valori ammessi per il motore Typst.
const ENGINES = ['gemini', 'nvidia'];
const PDF_MODES = ['auto', 'ocr'];
const FORMAT_WORKFLOWS = ['legacy', 'strict'];

const LIMITS = {
  maxPages: { min: 1, max: 2000 },
  chunkSize: { min: 1000, max: 30000 },
  ocrLongSide: { min: 1000, max: 5000 },
};

function readInt(key, fallback, { min, max }) {
  const raw = read(key, '');
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Endpoint non più validi salvati da versioni precedenti: vengono migrati
// automaticamente al default corrente.
const LEGACY_NVIDIA_ENDPOINTS = [
  'https://ai.api.nvidia.com/v1/gr/meta/nemotron-parse-1.1',
];

function read(key, fallback = '') {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* storage non disponibile (modalità privata): si procede in memoria */
  }
}

export function loadSettings() {
  let nvidiaEndpoint = read(KEYS.nvidiaEndpoint, DEFAULTS.nvidiaEndpoint);
  if (LEGACY_NVIDIA_ENDPOINTS.includes(nvidiaEndpoint)) {
    nvidiaEndpoint = DEFAULTS.nvidiaEndpoint;
  }
  // Migrazione trasparente: le installazioni precedenti avevano un solo
  // modello Gemini condiviso dalle due fasi.
  const legacyGeminiModel = read(KEYS.geminiModel, DEFAULTS.geminiTypstModel);
  return {
    nvidiaApiKey: read(KEYS.nvidia),
    googleApiKey: read(KEYS.google),
    nvidiaEndpoint,
    nvidiaModel: read(KEYS.nvidiaModel, DEFAULTS.nvidiaModel),
    geminiOcrModel: read(KEYS.geminiOcrModel, legacyGeminiModel),
    geminiTypstModel: read(KEYS.geminiTypstModel, legacyGeminiModel),
    ocrEngine: ENGINES.includes(read(KEYS.ocrEngine, DEFAULTS.ocrEngine))
      ? read(KEYS.ocrEngine, DEFAULTS.ocrEngine)
      : DEFAULTS.ocrEngine,
    typstEngine: ENGINES.includes(read(KEYS.typstEngine, DEFAULTS.typstEngine))
      ? read(KEYS.typstEngine, DEFAULTS.typstEngine)
      : DEFAULTS.typstEngine,
    nvidiaTypstModel: read(KEYS.nvidiaTypstModel, DEFAULTS.nvidiaTypstModel),
    fixEngine: ENGINES.includes(read(KEYS.fixEngine, DEFAULTS.fixEngine))
      ? read(KEYS.fixEngine, DEFAULTS.fixEngine)
      : DEFAULTS.fixEngine,
    fixModel: read(KEYS.fixModel, DEFAULTS.fixModel),
    pdfTextMode: PDF_MODES.includes(read(KEYS.pdfTextMode, DEFAULTS.pdfTextMode))
      ? read(KEYS.pdfTextMode, DEFAULTS.pdfTextMode)
      : DEFAULTS.pdfTextMode,
    maxPages: readInt(KEYS.maxPages, DEFAULTS.maxPages, LIMITS.maxPages),
    chunkSize: readInt(KEYS.chunkSize, DEFAULTS.chunkSize, LIMITS.chunkSize),
    fixTypos: readBool(KEYS.fixTypos, DEFAULTS.fixTypos),
    ocrLongSide: readInt(KEYS.ocrLongSide, DEFAULTS.ocrLongSide, LIMITS.ocrLongSide),
    formatWorkflow: FORMAT_WORKFLOWS.includes(read(KEYS.formatWorkflow, DEFAULTS.formatWorkflow))
      ? read(KEYS.formatWorkflow, DEFAULTS.formatWorkflow)
      : DEFAULTS.formatWorkflow,
    compareOcr: readBool(KEYS.compareOcr, DEFAULTS.compareOcr),
  };
}

/** Legge un booleano ('1'/'0'); assente → fallback. */
function readBool(key, fallback) {
  const v = read(key, '');
  if (v === '1') return true;
  if (v === '0') return false;
  return fallback;
}

// Dizionario personale del controllo ortografico: parole (minuscole) che
// l'utente ha marcato come corrette (nomi propri, termini tecnici) e che non
// vanno più segnalate né inviate all'AI.
const SPELL_IGNORE_KEY = 'sc.spellIgnore';

/** @returns {string[]} parole ignorate (minuscole) */
export function loadSpellIgnore() {
  try {
    const v = JSON.parse(localStorage.getItem(SPELL_IGNORE_KEY));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** Aggiunge parole al dizionario personale. @returns {string[]} lista aggiornata */
export function addSpellIgnore(words) {
  const cur = new Set(loadSpellIgnore());
  for (const w of words || []) {
    if (typeof w === 'string' && w.trim()) cur.add(w.trim().toLowerCase());
  }
  const list = [...cur];
  write(SPELL_IGNORE_KEY, JSON.stringify(list));
  return list;
}

function writeInt(key, value, fallback, { min, max }) {
  const n = parseInt(value, 10);
  const clamped = Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  write(key, String(clamped));
}

export function saveSettings(s) {
  write(KEYS.nvidia, s.nvidiaApiKey?.trim());
  write(KEYS.google, s.googleApiKey?.trim());
  write(KEYS.nvidiaEndpoint, s.nvidiaEndpoint?.trim() || DEFAULTS.nvidiaEndpoint);
  write(KEYS.nvidiaModel, s.nvidiaModel?.trim() || DEFAULTS.nvidiaModel);
  write(KEYS.geminiOcrModel, s.geminiOcrModel?.trim() || DEFAULTS.geminiOcrModel);
  write(KEYS.geminiTypstModel, s.geminiTypstModel?.trim() || DEFAULTS.geminiTypstModel);
  write(KEYS.ocrEngine, ENGINES.includes(s.ocrEngine) ? s.ocrEngine : DEFAULTS.ocrEngine);
  write(KEYS.typstEngine, ENGINES.includes(s.typstEngine) ? s.typstEngine : DEFAULTS.typstEngine);
  write(KEYS.nvidiaTypstModel, s.nvidiaTypstModel?.trim() || DEFAULTS.nvidiaTypstModel);
  write(KEYS.fixEngine, ENGINES.includes(s.fixEngine) ? s.fixEngine : DEFAULTS.fixEngine);
  write(KEYS.fixModel, s.fixModel?.trim() || DEFAULTS.fixModel);
  write(KEYS.pdfTextMode, PDF_MODES.includes(s.pdfTextMode) ? s.pdfTextMode : DEFAULTS.pdfTextMode);
  writeInt(KEYS.maxPages, s.maxPages, DEFAULTS.maxPages, LIMITS.maxPages);
  writeInt(KEYS.chunkSize, s.chunkSize, DEFAULTS.chunkSize, LIMITS.chunkSize);
  write(KEYS.fixTypos, s.fixTypos ? '1' : '0');
  writeInt(KEYS.ocrLongSide, s.ocrLongSide, DEFAULTS.ocrLongSide, LIMITS.ocrLongSide);
  write(
    KEYS.formatWorkflow,
    FORMAT_WORKFLOWS.includes(s.formatWorkflow) ? s.formatWorkflow : DEFAULTS.formatWorkflow,
  );
  write(KEYS.compareOcr, s.compareOcr ? '1' : '0');
}
