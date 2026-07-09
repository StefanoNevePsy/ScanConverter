/*
  Ritaglio delle figure dal documento originale.

  Nemotron-Parse (modalità markdown_bbox) classifica i blocchi con un `type`
  ("Picture", "Caption", ecc.) e una bounding box normalizzata (0–1). Da qui
  ritagliamo le regioni-immagine dalla pagina sorgente e le incorporiamo nel
  PDF Typst finale.
*/

/** Carica un data URL in un HTMLImageElement. */
export function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Impossibile caricare l’immagine sorgente.'));
    img.src = dataUrl;
  });
}

/** Converte un data URL in byte grezzi. */
function dataUrlToBytes(dataUrl) {
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * Ritaglia la regione `bbox` (coordinate normalizzate 0–1) da un'immagine e
 * restituisce i byte PNG.
 * @param {HTMLImageElement} img
 * @param {{xmin:number,ymin:number,xmax:number,ymax:number}} bbox
 * @param {number} pad margine extra normalizzato attorno al ritaglio
 * @returns {Uint8Array}
 */
export function cropToPng(img, bbox, pad = 0.006) {
  const W = img.naturalWidth || img.width;
  const H = img.naturalHeight || img.height;
  const x = Math.max(0, (bbox.xmin - pad) * W);
  const y = Math.max(0, (bbox.ymin - pad) * H);
  const w = Math.min(W - x, (bbox.xmax - bbox.xmin + 2 * pad) * W);
  const h = Math.min(H - y, (bbox.ymax - bbox.ymin + 2 * pad) * H);

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w));
  canvas.height = Math.max(1, Math.round(h));
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, x, y, w, h, 0, 0, canvas.width, canvas.height);
  return dataUrlToBytes(canvas.toDataURL('image/png'));
}
