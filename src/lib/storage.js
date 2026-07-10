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
  typstEngine: 'sc.typstEngine',
  nvidiaTypstModel: 'sc.nvidiaTypstModel',
  fixEngine: 'sc.fixEngine',
  fixModel: 'sc.fixModel',
  maxPages: 'sc.maxPages',
  chunkSize: 'sc.chunkSize',
};

export const DEFAULTS = {
  // Endpoint hosted verificato: il NIM Nemotron-Parse risponde qui (stile
  // OpenAI chat/completions). Il vecchio ai.api.nvidia.com/gr/... dava 404.
  nvidiaEndpoint: 'https://integrate.api.nvidia.com/v1/chat/completions',
  nvidiaModel: 'nvidia/nemotron-parse',
  geminiModel: 'gemini-flash-latest',
  // Motore per la fase 2 (testo OCR → Typst): 'gemini' oppure 'nvidia'.
  typstEngine: 'gemini',
  // Modello NVIDIA usato quando typstEngine === 'nvidia' (istruct generico,
  // adatto alla generazione di codice).
  nvidiaTypstModel: 'meta/llama-3.3-70b-instruct',
  // Correzione AI degli errori di compilazione: motore e modello dedicati
  // (un modello "forte" da codice; la chiave NVIDIA c'è sempre, serve all'OCR).
  fixEngine: 'nvidia',
  fixModel: 'z-ai/glm-5.2',
  maxPages: 20, // pagine PDF per singolo caricamento
  chunkSize: 5000, // caratteri per chunk inviato a Gemini
};

// Valori ammessi per il motore Typst.
const ENGINES = ['gemini', 'nvidia'];

const LIMITS = {
  maxPages: { min: 1, max: 2000 },
  chunkSize: { min: 1000, max: 30000 },
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
  return {
    nvidiaApiKey: read(KEYS.nvidia),
    googleApiKey: read(KEYS.google),
    nvidiaEndpoint,
    nvidiaModel: read(KEYS.nvidiaModel, DEFAULTS.nvidiaModel),
    geminiModel: read(KEYS.geminiModel, DEFAULTS.geminiModel),
    typstEngine: ENGINES.includes(read(KEYS.typstEngine, DEFAULTS.typstEngine))
      ? read(KEYS.typstEngine, DEFAULTS.typstEngine)
      : DEFAULTS.typstEngine,
    nvidiaTypstModel: read(KEYS.nvidiaTypstModel, DEFAULTS.nvidiaTypstModel),
    fixEngine: ENGINES.includes(read(KEYS.fixEngine, DEFAULTS.fixEngine))
      ? read(KEYS.fixEngine, DEFAULTS.fixEngine)
      : DEFAULTS.fixEngine,
    fixModel: read(KEYS.fixModel, DEFAULTS.fixModel),
    maxPages: readInt(KEYS.maxPages, DEFAULTS.maxPages, LIMITS.maxPages),
    chunkSize: readInt(KEYS.chunkSize, DEFAULTS.chunkSize, LIMITS.chunkSize),
  };
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
  write(KEYS.geminiModel, s.geminiModel?.trim() || DEFAULTS.geminiModel);
  write(KEYS.typstEngine, ENGINES.includes(s.typstEngine) ? s.typstEngine : DEFAULTS.typstEngine);
  write(KEYS.nvidiaTypstModel, s.nvidiaTypstModel?.trim() || DEFAULTS.nvidiaTypstModel);
  write(KEYS.fixEngine, ENGINES.includes(s.fixEngine) ? s.fixEngine : DEFAULTS.fixEngine);
  write(KEYS.fixModel, s.fixModel?.trim() || DEFAULTS.fixModel);
  writeInt(KEYS.maxPages, s.maxPages, DEFAULTS.maxPages, LIMITS.maxPages);
  writeInt(KEYS.chunkSize, s.chunkSize, DEFAULTS.chunkSize, LIMITS.chunkSize);
}
