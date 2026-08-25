/*
  Preparazione delle pagine prima dell'OCR: rilevamento delle DOPPIE PAGINE
  (spread) dal rapporto d'aspetto e trasformazioni scelte dall'utente
  nell'anteprima (rotazione a multipli di 90°, divisione in due pagine).

  Le dimensioni si leggono dall'HEADER dell'immagine (PNG/JPEG/WebP) senza
  decodificarla: su un libro di 250 pagine il rilevamento è istantaneo.
  Le pagine senza modifiche passano intatte (nessuna ricompressione).
*/

/** Decodifica base64 → bytes dei primi `n` byte di un data URL. */
function headBytes(dataUrl, n = 4096) {
  const comma = dataUrl.indexOf(',');
  const b64 = dataUrl.slice(comma + 1, comma + 1 + Math.ceil((n * 4) / 3) + 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

const u32 = (b, o) => (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
const u16 = (b, o) => (b[o] << 8) | b[o + 1];

/**
 * Dimensioni di un'immagine data-URL leggendo solo l'header (PNG/JPEG/WebP).
 * @returns {{width:number,height:number}|null}
 */
export function imageSizeFromDataUrl(dataUrl) {
  try {
    const b = headBytes(dataUrl);
    // PNG: firma + IHDR a offset fisso.
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
      return { width: u32(b, 16) >>> 0, height: u32(b, 20) >>> 0 };
    }
    // JPEG: scandisci i segmenti fino a un marker SOF (C0–CF esclusi C4/C8/CC).
    if (b[0] === 0xff && b[1] === 0xd8) {
      let o = 2;
      while (o + 9 < b.length) {
        if (b[o] !== 0xff) {
          o++;
          continue;
        }
        const marker = b[o + 1];
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { width: u16(b, o + 7), height: u16(b, o + 5) };
        }
        o += 2 + u16(b, o + 2);
      }
      return null;
    }
    // WebP: RIFF....WEBP + chunk VP8/VP8L/VP8X.
    if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) {
      const tag = String.fromCharCode(b[12], b[13], b[14], b[15]);
      if (tag === 'VP8X') {
        return {
          width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)),
          height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)),
        };
      }
      if (tag === 'VP8 ') {
        return {
          width: (b[26] | (b[27] << 8)) & 0x3fff,
          height: (b[28] | (b[29] << 8)) & 0x3fff,
        };
      }
      if (tag === 'VP8L') {
        const n = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
        return { width: 1 + (n & 0x3fff), height: 1 + ((n >> 14) & 0x3fff) };
      }
    }
  } catch {
    /* header illeggibile */
  }
  return null;
}

// Una pagina singola di libro/rivista è verticale (~0.65–0.75); una doppia
// pagina è circa il doppio. Soglia prudente: più largo che alto del 25%.
const SPREAD_RATIO = 1.25;

/** True se l'immagine sembra una doppia pagina (spread). */
export function isSpreadLike(dataUrl) {
  const size = imageSizeFromDataUrl(dataUrl);
  return !!size && size.height > 0 && size.width / size.height >= SPREAD_RATIO;
}

/** Carica un data URL in un HTMLImageElement. */
function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Immagine di pagina illeggibile.'));
    img.src = dataUrl;
  });
}

/**
 * Applica a una pagina la rotazione (0/90/180/270, oraria) e l'eventuale
 * divisione in due pagine (sinistra, destra — dopo la rotazione).
 * Senza modifiche l'immagine passa intatta.
 * @param {string} dataUrl
 * @param {{rotate?:number, split?:boolean}} edit
 * @returns {Promise<string[]>} 1 o 2 data URL
 */
export async function transformPage(dataUrl, edit = {}) {
  const rotate = ((edit.rotate || 0) % 360 + 360) % 360;
  const split = !!edit.split;
  if (!rotate && !split) return [dataUrl];

  const img = await loadImage(dataUrl);
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const swapped = rotate === 90 || rotate === 270;

  const canvas = document.createElement('canvas');
  canvas.width = swapped ? h : w;
  canvas.height = swapped ? w : h;
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((rotate * Math.PI) / 180);
  ctx.drawImage(img, -w / 2, -h / 2);

  if (!split) return [canvas.toDataURL('image/png')];

  const halfW = Math.floor(canvas.width / 2);
  const halves = [];
  // Sinistra [0, halfW), destra [halfW, width): ordine di lettura occidentale.
  for (const [offset, width] of [
    [0, halfW],
    [halfW, canvas.width - halfW],
  ]) {
    const half = document.createElement('canvas');
    half.width = width;
    half.height = canvas.height;
    const hctx = half.getContext('2d', { alpha: false });
    hctx.drawImage(canvas, offset, 0, width, half.height, 0, 0, width, half.height);
    halves.push(half.toDataURL('image/png'));
  }
  return halves;
}

/**
 * Miniatura per l'anteprima pagine.
 *
 * L'anteprima mostra un `<img>` per pagina: usare i data URL a piena
 * risoluzione significa tenere nel DOM centinaia di MB di bitmap decodificate
 * (un libro di 250 pagine a 2600px è ingestibile). La miniatura serve solo a
 * giudicare rotazione e doppia pagina, quindi bastano poche centinaia di px.
 * L'immagine a piena risoluzione resta quella usata per l'OCR.
 *
 * @param {string} dataUrl
 * @param {number} [maxSide] lato lungo della miniatura in px
 * @returns {Promise<string>} data URL JPEG leggero (l'originale se fallisce)
 */
export async function makeThumbnail(dataUrl, maxSide = 320) {
  try {
    const img = await loadImage(dataUrl);
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    const scale = Math.min(1, maxSide / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.72);
  } catch {
    return dataUrl; // meglio l'originale che nessuna anteprima
  }
}

/**
 * Applica le modifiche dell'anteprima a tutte le pagine, in ordine.
 * @param {string[]} dataUrls
 * @param {{rotate?:number, split?:boolean}[]} edits una voce per pagina
 * @param {(done:number,total:number)=>void} [onProgress]
 * @returns {Promise<string[]>} elenco finale (gli spread contano doppio)
 */
/**
 * Dove finisce ogni pagina dopo rotazioni e divisioni.
 *
 * Una doppia pagina divisa diventa due immagini e sposta in avanti tutte
 * quelle che seguono. Lavorando su disco (una pagina alla volta, per non
 * tenere in memoria l'intero libro) bisogna sapere prima dove scrivere, e
 * procedere DALL'ULTIMA verso la prima: così ciò che si sovrascrive è già
 * stato letto.
 *
 * @param {number} count numero di pagine di partenza
 * @param {{split?:boolean}[]} [edits]
 * @returns {{total:number, plan:{index:number, targets:number[]}[]}}
 *   `plan` è già nell'ordine in cui va eseguito (dall'ultima alla prima)
 */
export function pageTargets(count, edits) {
  const pagine = Math.max(0, Math.floor(Number(count) || 0));
  const quante = (index) => (edits?.[index]?.split ? 2 : 1);
  let total = 0;
  for (let index = 0; index < pagine; index++) total += quante(index);
  const plan = [];
  let cursore = total;
  for (let index = pagine - 1; index >= 0; index--) {
    const n = quante(index);
    cursore -= n;
    plan.push({ index, targets: Array.from({ length: n }, (_, k) => cursore + k) });
  }
  return { total, plan };
}

export async function preparePages(dataUrls, edits, onProgress) {
  const out = [];
  for (let i = 0; i < dataUrls.length; i++) {
    onProgress?.(i + 1, dataUrls.length);
    const pages = await transformPage(dataUrls[i], edits?.[i] || {});
    out.push(...pages);
  }
  return out;
}
