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
  geminiModel: 'sc.geminiModel',
};

export const DEFAULTS = {
  nvidiaEndpoint: 'https://ai.api.nvidia.com/v1/gr/meta/nemotron-parse-1.1',
  geminiModel: 'gemini-flash-latest',
};

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
  return {
    nvidiaApiKey: read(KEYS.nvidia),
    googleApiKey: read(KEYS.google),
    nvidiaEndpoint: read(KEYS.nvidiaEndpoint, DEFAULTS.nvidiaEndpoint),
    geminiModel: read(KEYS.geminiModel, DEFAULTS.geminiModel),
  };
}

export function saveSettings(s) {
  write(KEYS.nvidia, s.nvidiaApiKey?.trim());
  write(KEYS.google, s.googleApiKey?.trim());
  write(KEYS.nvidiaEndpoint, s.nvidiaEndpoint?.trim() || DEFAULTS.nvidiaEndpoint);
  write(KEYS.geminiModel, s.geminiModel?.trim() || DEFAULTS.geminiModel);
}
