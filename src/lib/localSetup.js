/*
  Installazione degli accessori locali: quello che l'app può fare, e quello
  che deve chiedere.

  ScanConverter gira in un browser o in una WebView: non può installare
  programmi, scrivere variabili d'ambiente di sistema o scaricare gigabyte in
  una cartella scelta dall'utente. Nessuna quantità di codice qui cambia
  questo fatto. Quello che può fare — e che finora non faceva — è:

  - comporre il comando ESATTO per la macchina su cui sta girando, con il
    percorso scelto già dentro, così non resta niente da indovinare;
  - leggere, sul desktop, l'esito lasciato dallo script e proporre gli
    indirizzi giusti invece di farli ridigitare;
  - verificare da sé se i servizi rispondono, invece di lasciare l'utente
    davanti a un errore di rete alla prima pagina scansionata.
*/

import { DEFAULT_LOCAL_ENDPOINT, DEFAULT_LOCAL_OCR_ENDPOINT } from './local.js';

/** Componenti installabili, con quel che serve per decidere se prenderli. */
export const COMPONENTS = [
  {
    id: 'ollama',
    label: 'Modello linguistico (Ollama)',
    note: 'Rilettura, struttura e traduzione in locale. ~5 GB con qwen3:8b.',
    default: true,
  },
  {
    id: 'typst',
    label: 'Compilatore Typst nativo',
    note: 'Compilazione più rapida del WASM sui documenti lunghi. ~30 MB.',
    default: true,
  },
  {
    id: 'sidecar',
    label: 'OCR locale (sidecar)',
    note: 'Richiede GPU NVIDIA con CUDA, e su Windows anche WSL2.',
    default: false,
  },
];

/** Piattaforma su cui gira l'app: decide quale comando mostrare. */
export function detectPlatform() {
  const hint = `${globalThis.navigator?.userAgentData?.platform || ''} ${globalThis.navigator?.platform || ''} ${globalThis.navigator?.userAgent || ''}`;
  if (/win/i.test(hint)) return 'windows';
  if (/mac|darwin/i.test(hint)) return 'macos';
  return 'linux';
}

/** Percorso proposto: una cartella sola, su un disco che l'utente sceglie. */
export function suggestedRoot(platform = detectPlatform()) {
  if (platform === 'windows') return 'D:\\ScanConverter';
  if (platform === 'macos') return '/Volumes/Esterno/ScanConverter';
  return '/media/esterno/ScanConverter';
}

/** Cita un percorso per la shell giusta, che è dove si sbaglia sempre. */
function quote(value, platform) {
  const path = String(value || '').trim();
  if (platform === 'windows') return `'${path.replace(/'/g, "''")}'`;
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

/**
 * Il comando da incollare, già completo.
 *
 * @param {{root:string, components:string[], model?:string, platform?:string}} p
 * @returns {{shell:string, command:string, note:string}}
 */
export function buildCommand({ root, components, model, platform = detectPlatform() }) {
  const list = (components?.length ? components : ['ollama', 'typst']).join(',');
  const modelArg = model?.trim();

  if (platform === 'windows') {
    const parts = [
      '.\\Install-ScanConverter.ps1',
      `-Root ${quote(root, platform)}`,
      `-Components ${list}`,
    ];
    if (modelArg) parts.push(`-Model ${modelArg}`);
    return {
      shell: 'PowerShell',
      command: parts.join(' '),
      note:
        'Apri PowerShell nella cartella tools\\setup del progetto. Se Windows ' +
        'blocca lo script, prima: Set-ExecutionPolicy -Scope Process Bypass',
    };
  }

  const parts = [
    './install-scanconverter.sh',
    `--root ${quote(root, platform)}`,
    `--components ${list}`,
  ];
  if (modelArg) parts.push(`--model ${modelArg}`);
  return {
    shell: platform === 'macos' ? 'Terminale' : 'shell',
    command: parts.join(' '),
    note: 'Esegui dalla cartella tools/setup del progetto.',
  };
}

/**
 * Il servizio locale risponde davvero?
 *
 * Vale più di qualunque istruzione scritta: dice se il lavoro è finito. Una
 * richiesta che fallisce per CORS conta come raggiunta — il server c'è, è il
 * browser a non voler leggere la risposta di una richiesta di sola prova.
 *
 * @returns {Promise<{ok:boolean, detail:string}>}
 */
export async function probe(url, { timeout = 4000 } = {}) {
  const target = String(url || '').trim();
  if (!target) return { ok: false, detail: 'Indirizzo non impostato.' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(target, { method: 'GET', signal: controller.signal });
    return { ok: true, detail: `Risponde (HTTP ${res.status}).` };
  } catch (error) {
    if (error?.name === 'AbortError') return { ok: false, detail: 'Nessuna risposta entro 4 secondi.' };
    return { ok: false, detail: 'Non raggiungibile: il servizio è avviato?' };
  } finally {
    clearTimeout(timer);
  }
}

/** Indirizzo /v1/models a partire da quello di chat, per la prova. */
export function modelsUrl(endpoint) {
  return String(endpoint || DEFAULT_LOCAL_ENDPOINT).replace(/\/chat\/completions\/?$/, '/models');
}

/** Indirizzo /health del sidecar, per la prova. */
export function healthUrl(endpoint) {
  return String(endpoint || DEFAULT_LOCAL_OCR_ENDPOINT).replace(/\/ocr\/?$/, '/health');
}

/**
 * Esito dell'installazione, se il processo desktop lo espone.
 * Sul web non c'è modo di leggere un file dal disco: si restituisce
 * `{found:false}` e l'interfaccia chiede gli indirizzi come sempre.
 */
export async function readLocalSetup() {
  const bridge = globalThis.window?.scanConverterDesktop;
  if (typeof bridge?.localSetup !== 'function') return { found: false };
  try {
    return await bridge.localSetup();
  } catch {
    return { found: false };
  }
}

/** Selettore di cartella di sistema; null se non siamo sul desktop. */
export async function chooseFolder() {
  const bridge = globalThis.window?.scanConverterDesktop;
  if (typeof bridge?.chooseFolder !== 'function') return null;
  try {
    const result = await bridge.chooseFolder();
    return result?.cancelled ? null : result?.path || null;
  } catch {
    return null;
  }
}
