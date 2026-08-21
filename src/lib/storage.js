/*
  Persistenza locale delle configurazioni (chiavi API ed endpoint).
  Le chiavi restano SOLO nel localStorage del browser dell'utente: non
  vengono mai inviate a nessun server tranne le due API ufficiali chiamate
  direttamente dal client.
*/

import { ENGINES, PHASES, PHASE_DEFAULTS, normalizeEngine } from './phases.js';

const KEYS = {
  nvidia: 'sc.nvidiaApiKey',
  google: 'sc.googleApiKey',
  nvidiaEndpoint: 'sc.nvidiaEndpoint',
  phases: 'sc.phases',
  pdfTextMode: 'sc.pdfTextMode',
  maxPages: 'sc.maxPages',
  chunkSize: 'sc.chunkSize',
  fixTypos: 'sc.fixTypos',
  ocrLongSide: 'sc.ocrLongSide',
  formatWorkflow: 'sc.formatWorkflow',
  compareOcr: 'sc.compareOcr',
  refineTables: 'sc.refineTables',
  localEndpoint: 'sc.localEndpoint',
  localModel: 'sc.localModel',
  localOcrEndpoint: 'sc.localOcrEndpoint',
  docContext: 'sc.docContext',
  sourceLang: 'sc.sourceLang',
  targetLang: 'sc.targetLang',
  translateOverlap: 'sc.translateOverlap',
};

// Chiavi delle versioni precedenti: lette una sola volta per costruire
// `phases`, poi non più scritte. Restano nel localStorage dell'utente senza
// dare fastidio — riscriverle significherebbe mantenere due verità.
const LEGACY = {
  nvidiaModel: 'sc.nvidiaModel',
  geminiModel: 'sc.geminiModel',
  geminiOcrModel: 'sc.geminiOcrModel',
  geminiTypstModel: 'sc.geminiTypstModel',
  ocrEngine: 'sc.ocrEngine',
  typstEngine: 'sc.typstEngine',
  nvidiaTypstModel: 'sc.nvidiaTypstModel',
  fixEngine: 'sc.fixEngine',
  fixModel: 'sc.fixModel',
  localModel: 'sc.localModel',
};

export const DEFAULTS = {
  // Endpoint hosted verificato: il NIM Nemotron-Parse risponde qui (stile
  // OpenAI chat/completions). Il vecchio ai.api.nvidia.com/gr/... dava 404.
  nvidiaEndpoint: 'https://integrate.api.nvidia.com/v1/chat/completions',
  // Motore e modello di OGNI fase: vedi phases.js. Una sola convenzione al
  // posto delle cinque coppie sparse di prima.
  phases: PHASE_DEFAULTS,
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
  // Riparsing delle tabelle ritagliandole e rimandandole al modello vision:
  // la struttura righe/colonne si recupera solo dall'immagine. Richiede bbox
  // (motore OCR NVIDIA) e la chiave Google.
  refineTables: false,
  // Pipeline LOCALE (branch sperimentale): un server OpenAI-compatibile sulla
  // macchina dell'utente per le fasi testuali, e un sidecar che incapsula
  // Nemotron OCR v2 per la fase immagine → testo. Nessuna chiave richiesta.
  localEndpoint: 'http://localhost:11434/v1/chat/completions',
  localOcrEndpoint: 'http://localhost:8000/ocr',
  // Traduzione (fase separata, mai in sovrascrittura dell'originale).
  sourceLang: 'auto',
  targetLang: 'en',
  // Frasi di contesto passate prima e dopo ogni blocco da tradurre: senza,
  // il modello non sa a cosa si riferiscono i pronomi a cavallo del taglio.
  translateOverlap: 2,
  // Contesto del documento in una frase (dominio, autori, termini ricorrenti).
  // Serve ai modelli per NON "correggere" il lessico specialistico: senza,
  // «parentificazione» o «ipercircolarità» sembrano refusi da aggiustare.
  docContext: '',
};

const PDF_MODES = ['auto', 'ocr'];
const FORMAT_WORKFLOWS = ['legacy', 'strict'];

const LIMITS = {
  maxPages: { min: 1, max: 2000 },
  chunkSize: { min: 1000, max: 30000 },
  ocrLongSide: { min: 1000, max: 5000 },
  translateOverlap: { min: 0, max: 6 },
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

/**
 * Ricostruisce `phases` dai campi sparsi delle versioni precedenti.
 *
 * Chi aggiorna l'app non deve riconfigurare nulla: la coppia motore/modello
 * che aveva scelto per ogni fase viene ritrovata dov'era. La traduzione non
 * esisteva prima, quindi parte dai suoi default.
 */
function migratedPhases() {
  const geminiFallback = read(LEGACY.geminiModel, PHASE_DEFAULTS.typst.models.gemini);
  const localFallback = read(LEGACY.localModel, PHASE_DEFAULTS.typst.models.local);
  const legacy = {
    ocr: {
      engine: read(LEGACY.ocrEngine, ''),
      models: {
        nvidia: read(LEGACY.nvidiaModel, ''),
        gemini: read(LEGACY.geminiOcrModel, geminiFallback),
        local: '',
      },
    },
    typst: {
      engine: read(LEGACY.typstEngine, ''),
      models: {
        nvidia: read(LEGACY.nvidiaTypstModel, ''),
        gemini: read(LEGACY.geminiTypstModel, geminiFallback),
        local: localFallback,
      },
    },
    // Rilettura e riparazione condividevano `fixEngine`/`fixModel`: restano
    // separate d'ora in poi, ma partono dalla stessa scelta di prima.
    proof: {
      engine: read(LEGACY.fixEngine, ''),
      models: { nvidia: read(LEGACY.fixModel, ''), gemini: geminiFallback, local: localFallback },
    },
    fix: {
      engine: read(LEGACY.fixEngine, ''),
      models: { nvidia: read(LEGACY.fixModel, ''), gemini: geminiFallback, local: localFallback },
    },
    translate: { engine: '', models: { local: localFallback } },
  };

  const out = {};
  for (const phase of PHASES) {
    const base = PHASE_DEFAULTS[phase];
    const old = legacy[phase] || {};
    const models = { ...base.models };
    for (const engine of ENGINES) {
      const value = String(old.models?.[engine] || '').trim();
      if (value) models[engine] = value;
    }
    out[phase] = { engine: normalizeEngine(phase, old.engine || base.engine), models };
  }
  return out;
}

function loadPhases() {
  let stored = null;
  try {
    stored = JSON.parse(read(KEYS.phases, 'null'));
  } catch {
    stored = null;
  }
  if (!stored || typeof stored !== 'object') return migratedPhases();
  const out = {};
  for (const phase of PHASES) {
    const base = PHASE_DEFAULTS[phase];
    const saved = stored[phase];
    const models = { ...base.models };
    for (const engine of ENGINES) {
      const value = String(saved?.models?.[engine] || '').trim();
      if (value) models[engine] = value;
    }
    out[phase] = { engine: normalizeEngine(phase, saved?.engine || base.engine), models };
  }
  return out;
}

export function loadSettings() {
  let nvidiaEndpoint = read(KEYS.nvidiaEndpoint, DEFAULTS.nvidiaEndpoint);
  if (LEGACY_NVIDIA_ENDPOINTS.includes(nvidiaEndpoint)) {
    nvidiaEndpoint = DEFAULTS.nvidiaEndpoint;
  }
  return {
    nvidiaApiKey: read(KEYS.nvidia),
    googleApiKey: read(KEYS.google),
    nvidiaEndpoint,
    phases: loadPhases(),
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
    refineTables: readBool(KEYS.refineTables, DEFAULTS.refineTables),
    localEndpoint: read(KEYS.localEndpoint, DEFAULTS.localEndpoint),
    localOcrEndpoint: read(KEYS.localOcrEndpoint, DEFAULTS.localOcrEndpoint),
    docContext: read(KEYS.docContext, DEFAULTS.docContext),
    sourceLang: read(KEYS.sourceLang, DEFAULTS.sourceLang),
    targetLang: read(KEYS.targetLang, DEFAULTS.targetLang),
    translateOverlap: readInt(
      KEYS.translateOverlap,
      DEFAULTS.translateOverlap,
      LIMITS.translateOverlap,
    ),
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
  writePhases(s.phases);
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
  write(KEYS.refineTables, s.refineTables ? '1' : '0');
  write(KEYS.localEndpoint, s.localEndpoint?.trim() || DEFAULTS.localEndpoint);
  write(KEYS.localOcrEndpoint, s.localOcrEndpoint?.trim() || DEFAULTS.localOcrEndpoint);
  write(KEYS.docContext, s.docContext?.trim() || '');
  write(KEYS.sourceLang, s.sourceLang?.trim() || DEFAULTS.sourceLang);
  write(KEYS.targetLang, s.targetLang?.trim() || DEFAULTS.targetLang);
  writeInt(
    KEYS.translateOverlap,
    s.translateOverlap,
    DEFAULTS.translateOverlap,
    LIMITS.translateOverlap,
  );
}

/**
 * Salva le fasi come un unico oggetto: aggiungere una fase o un motore non
 * richiede più di inventare una chiave nuova nel localStorage.
 */
function writePhases(phases) {
  const out = {};
  for (const phase of PHASES) {
    const base = PHASE_DEFAULTS[phase];
    const saved = phases?.[phase];
    const models = {};
    for (const engine of ENGINES) {
      models[engine] = String(saved?.models?.[engine] ?? base.models[engine] ?? '').trim();
    }
    out[phase] = { engine: normalizeEngine(phase, saved?.engine || base.engine), models };
  }
  write(KEYS.phases, JSON.stringify(out));
}
