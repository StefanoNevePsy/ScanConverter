/*
  Utilità per la gestione dei file caricati (immagini o PDF).
*/

export const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'];

/*
  Due limiti diversi, perché i due casi hanno vincoli diversi.

  Un'IMMAGINE singola viene spedita intera dentro una richiesta al motore OCR,
  codificata in base64 (che la gonfia di un terzo): oltre una ventina di
  megabyte le API la rifiutano, e il tetto è una cortesia, non un capriccio.

  Un PDF invece non viene mai spedito: si rasterizza pagina per pagina e ogni
  pagina va su disco appena pronta. Quello che conta non è quanto pesa il file,
  ma quanto pesa UNA pagina — perciò qui il tetto può essere largo. Prima erano
  venti megabyte per entrambi, e un libro scansionato bene li supera senza
  essere in alcun modo problematico.
*/
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MB
export const MAX_PDF_BYTES = 500 * 1024 * 1024; // 500 MB

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
  const limite = isPdf(file) ? MAX_PDF_BYTES : MAX_IMAGE_BYTES;
  if (file.size > limite) {
    const mb = Math.round(limite / (1024 * 1024));
    return isPdf(file)
      ? `PDF troppo grande (massimo ${mb} MB).`
      : `Immagine troppo grande (massimo ${mb} MB): oltre questa dimensione i ` +
        'motori OCR rifiutano la richiesta. Con un PDF il limite è molto più alto.';
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
