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
};

export const DEFAULTS = {
  // Endpoint hosted verificato: il NIM Nemotron-Parse risponde qui (stile
  // OpenAI chat/completions). Il vecchio ai.api.nvidia.com/gr/... dava 404.
  nvidiaEndpoint: 'https://integrate.api.nvidia.com/v1/chat/completions',
  nvidiaModel: 'nvidia/nemotron-parse',
  geminiModel: 'gemini-flash-latest',
};

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
  };
}

export function saveSettings(s) {
  write(KEYS.nvidia, s.nvidiaApiKey?.trim());
  write(KEYS.google, s.googleApiKey?.trim());
  write(KEYS.nvidiaEndpoint, s.nvidiaEndpoint?.trim() || DEFAULTS.nvidiaEndpoint);
  write(KEYS.nvidiaModel, s.nvidiaModel?.trim() || DEFAULTS.nvidiaModel);
  write(KEYS.geminiModel, s.geminiModel?.trim() || DEFAULTS.geminiModel);
}
