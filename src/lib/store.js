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
const DB_VERSION = 2;

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
        // v2: immagini delle pagine rasterizzate, cache di ripresa dell'OCR.
        // Vengono cancellate mano a mano che ogni pagina è estratta.
        if (!db.objectStoreNames.contains('page')) {
          db.createObjectStore('page', { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

/**
 * Chiede al browser di rendere PERSISTENTE lo storage dell'origine, così i
 * dati (sessioni, pagine, figure) non vengono sfrattati sotto pressione di
 * disco. Best-effort: su app Android/desktop è di fatto già permanente.
 */
export async function requestPersistentStorage() {
  try {
    if (navigator.storage?.persist) {
      const already = await navigator.storage.persisted?.();
      if (!already) return await navigator.storage.persist();
      return true;
    }
  } catch {
    /* API non disponibile */
  }
  return false;
}

/**
 * Intervallo delle chiavi `${id}::…` di UNA sessione.
 *
 * Serve a non leggere mai l'intero object store: `getAll()` senza intervallo
 * materializza in RAM le pagine e le figure di TUTTE le sessioni: su un libro
 * di 250 pagine sono centinaia di MB di data URL, abbastanza da far uccidere
 * la WebView su telefono. Gli id sono `${timestamp}-${random}` (lunghezza
 * fissa), quindi nessun id è prefisso di un altro e l'intervallo è esatto.
 */
function idRange(id) {
  return IDBKeyRange.bound(`${id}::`, `${id}::` + '\uffff');
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
    await tx('figure', 'readwrite', (s) => s.delete(idRange(id)));
    await deletePagesFor(id);
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
        os.put({
          key: `${id}::${f.path}`,
          id,
          path: f.path,
          bytes: f.bytes,
          widthPct: f.widthPct,
          junk: f.junk,
        });
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
    const all = (await tx('figure', 'readonly', (s) => s.getAll(idRange(id)))) || [];
    return all
      .map((f) => ({
        path: f.path,
        bytes: f.bytes instanceof Uint8Array ? f.bytes : new Uint8Array(f.bytes),
        widthPct: f.widthPct,
        junk: f.junk,
      }));
  } catch {
    return [];
  }
}

/** Elimina dallo storage le figure indicate (per percorso) di una sessione. */
export async function deleteFigures(id, paths) {
  if (!paths?.length) return;
  try {
    await tx('figure', 'readwrite', (s) => {
      for (const p of paths) s.delete(`${id}::${p}`);
    });
  } catch {
    /* ignora */
  }
}

/**
 * Salva le immagini (data URL) delle pagine rasterizzate: cache per riprendere
 * l'OCR di documenti lunghi senza rirasterizzare né richiedere di nuovo il
 * file. Vengono cancellate una a una man mano che l'OCR le consuma.
 * @param {string} id
 * @param {string[]} dataUrls una per pagina, in ordine
 */
export async function savePages(id, dataUrls) {
  if (!dataUrls?.length) return;
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const t = db.transaction('page', 'readwrite');
      const os = t.objectStore('page');
      dataUrls.forEach((dataUrl, index) => {
        os.put({ key: `${id}::${index}`, id, index, dataUrl });
      });
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  } catch {
    /* persistenza non disponibile: l'OCR resta comunque in memoria */
  }
}

/** Ritorna le pagine ancora in cache per una sessione, ordinate per indice. */
export async function getPages(id) {
  try {
    const all = (await tx('page', 'readonly', (s) => s.getAll(idRange(id)))) || [];
    return all
      .sort((a, b) => a.index - b.index)
      .map((p) => ({ index: p.index, dataUrl: p.dataUrl }));
  } catch {
    return [];
  }
}

/**
 * Indici delle pagine ancora in cache, senza leggerne le immagini: permette di
 * sapere cosa resta da estrarre pagando solo le chiavi.
 * @returns {Promise<number[]>} indici ordinati
 */
export async function getPageIndexes(id) {
  try {
    const keys = (await tx('page', 'readonly', (s) => s.getAllKeys(idRange(id)))) || [];
    return keys
      .map((k) => parseInt(String(k).slice(String(k).lastIndexOf('::') + 2), 10))
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

/**
 * UNA pagina della cache. L'OCR procede una pagina per volta e la cancella
 * subito dopo: caricarle tutte insieme significherebbe tenere in RAM l'intero
 * libro rasterizzato.
 * @returns {Promise<string|null>} data URL, oppure null se non più in cache
 */
export async function getPage(id, index) {
  try {
    const rec = await tx('page', 'readonly', (s) => s.get(`${id}::${index}`));
    return rec?.dataUrl || null;
  } catch {
    return null;
  }
}

/** Cancella l'immagine di una pagina (dopo che l'OCR l'ha estratta). */
export async function deletePage(id, index) {
  try {
    await tx('page', 'readwrite', (s) => s.delete(`${id}::${index}`));
  } catch {
    /* ignora */
  }
}

/** Cancella tutte le pagine in cache di una sessione (a OCR completato). */
export async function deletePagesFor(id) {
  try {
    await tx('page', 'readwrite', (s) => s.delete(idRange(id)));
  } catch {
    /* ignora */
  }
}
