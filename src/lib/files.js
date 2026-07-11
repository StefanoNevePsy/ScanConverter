/*
  Utilità per la gestione dei file caricati (immagini o PDF).
*/

export const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'];
export const MAX_BYTES = 20 * 1024 * 1024; // 20 MB

/**
 * Legge un File/Blob (anche file-like proveniente da una WebView nativa) come
 * data URL base64 (`data:<mime>;base64,...`).
 * @param {File|Blob|{arrayBuffer:()=>Promise<ArrayBuffer>,type?:string}} file
 * @returns {Promise<string>}
 */
export async function fileToDataUrl(file) {
  if (!file) throw new TypeError('Nessun file da leggere.');

  // Alcune WebView/integrazioni native restituiscono oggetti con l'API di un
  // File ma senza il brand interno Blob richiesto da FileReader. Convertire i
  // byte in un Blob locale evita il TypeError "parameter 1 is not of type
  // Blob". Per i normali File del browser manteniamo l'oggetto originale.
  let source = file;
  if (!(source instanceof Blob)) {
    if (typeof source.arrayBuffer !== 'function') {
      throw new TypeError('Il file selezionato non contiene dati leggibili.');
    }
    source = new Blob([await source.arrayBuffer()], {
      type: typeof source.type === 'string' ? source.type : '',
    });
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Impossibile leggere il file.'));
    reader.readAsDataURL(source);
  });
}

/**
 * Estrae la sola parte base64 (senza il prefisso `data:...;base64,`).
 * @param {string} dataUrl
 * @returns {string}
 */
export function stripBase64Prefix(dataUrl) {
  const comma = dataUrl.indexOf(',');
  return comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
}

/**
 * Valida un file rispetto a tipo e dimensione.
 * @param {File} file
 * @returns {string|null} messaggio d'errore o null se valido
 */
export function validateFile(file) {
  if (!file) return 'Nessun file selezionato.';
  if (!ACCEPTED.includes(file.type)) {
    return 'Formato non supportato. Usa PNG, JPEG, WebP o PDF.';
  }
  if (file.size > MAX_BYTES) {
    return 'File troppo grande (massimo 20 MB).';
  }
  return null;
}

export function isPdf(file) {
  return file?.type === 'application/pdf';
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
