/*
  Persistenza delle sessioni su IndexedDB.

  localStorage (~5 MB, sincrono, solo stringhe) è insufficiente per libri
  interi con figure. IndexedDB gestisce testo esteso e dati binari (i byte
  delle immagini) in modo asincrono, con capienza molto maggiore, sia su web
  sia nella WebView Android di Capacitor.

  Due object store:
    - `session`: metadati testuali (chunk, corpi Typst, preambolo, outline).
      Riscritto a ogni chunk completato (leggero).
    - `figure`: byte delle immagini ritagliate. Scritti una sola volta.
*/

const DB_NAME = 'scanconverter';
const DB_VERSION = 1;

let dbPromise = null;

function openDB() {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB non disponibile'));
  }
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('session')) {
          db.createObjectStore('session', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('figure')) {
          db.createObjectStore('figure', { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function tx(store, mode, fn) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        t.oncomplete = () => resolve(req?.result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

/** True se la persistenza è utilizzabile in questo ambiente. */
export async function persistenceAvailable() {
  try {
    await openDB();
    return true;
  } catch {
    return false;
  }
}

/** Salva/aggiorna i metadati di una sessione (senza figure). */
export async function saveSession(meta) {
  try {
    await tx('session', 'readwrite', (s) => s.put({ ...meta, updatedAt: Date.now() }));
  } catch {
    /* persistenza non disponibile: si procede in memoria */
  }
}

export async function getSession(id) {
  try {
    return await tx('session', 'readonly', (s) => s.get(id));
  } catch {
    return null;
  }
}

export async function listSessions() {
  try {
    return (await tx('session', 'readonly', (s) => s.getAll())) || [];
  } catch {
    return [];
  }
}

/** La sessione incompleta più recente (per proporre la ripresa all'avvio). */
export async function getResumableSession() {
  const all = await listSessions();
  return (
    all
      .filter((x) => x.status && x.status !== 'done')
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0] || null
  );
}

export async function deleteSession(id) {
  try {
    await tx('session', 'readwrite', (s) => s.delete(id));
    const figs = await tx('figure', 'readonly', (s) => s.getAll());
    await openDB().then(
      (db) =>
        new Promise((resolve, reject) => {
          const t = db.transaction('figure', 'readwrite');
          const os = t.objectStore('figure');
          (figs || []).forEach((f) => {
            if (f.id === id) os.delete(f.key);
          });
          t.oncomplete = () => resolve();
          t.onerror = () => reject(t.error);
        }),
    );
  } catch {
    /* ignora */
  }
}

/** Scrive i byte delle figure di una sessione (una sola volta). */
export async function saveFigures(id, figures) {
  if (!figures?.length) return;
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const t = db.transaction('figure', 'readwrite');
      const os = t.objectStore('figure');
      for (const f of figures) {
        os.put({ key: `${id}::${f.path}`, id, path: f.path, bytes: f.bytes });
      }
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  } catch {
    /* ignora */
  }
}

export async function getFigures(id) {
  try {
    const all = (await tx('figure', 'readonly', (s) => s.getAll())) || [];
    return all
      .filter((f) => f.id === id)
      .map((f) => ({
        path: f.path,
        bytes: f.bytes instanceof Uint8Array ? f.bytes : new Uint8Array(f.bytes),
      }));
  } catch {
    return [];
  }
}
