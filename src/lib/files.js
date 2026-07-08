/*
  Utilità per la gestione dei file caricati (immagini o PDF).
*/

export const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'];
export const MAX_BYTES = 20 * 1024 * 1024; // 20 MB

/**
 * Legge un File come data URL base64 (`data:<mime>;base64,...`).
 * @param {File} file
 * @returns {Promise<string>}
 */
export function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Impossibile leggere il file.'));
    reader.readAsDataURL(file);
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

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
