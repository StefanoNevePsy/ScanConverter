/*
  Raddrizzamento delle pagine scansionate: inclinazione E curvatura.

  Il problema tipico delle fotocopie di libri non è la pagina storta tutta
  insieme, ma l'«onda»: vicino alla rilegatura la carta si piega, e le righe
  di testo si incurvano verso l'alto o verso il basso. Un deskew a rotazione
  unica non lo corregge.

  Metodo (deterministico, senza IA, tutto nel browser):
  1. su una copia rimpicciolita si trova l'inchiostro (soglia locale);
  2. la pagina si divide in strisce verticali; per ogni striscia il profilo
     orizzontale dell'inchiostro mostra dove stanno le righe di testo;
  3. confrontando strisce vicine si misura di quanto le righe salgono o
     scendono andando verso la rilegatura — separatamente in alto, al centro
     e in basso, perché la curvatura cambia lungo la pagina;
  4. le misure diventano una curva liscia per fascia (polinomio), e da lì un
     campo di spostamento verticale per ogni punto della pagina;
  5. l'immagine a piena risoluzione viene rimappata con quello spostamento.

  Una pagina già dritta produce spostamenti quasi nulli e resta INTATTA: si
  interviene solo sopra una soglia minima. In più, a richiesta, si
  normalizza il contrasto (toglie l'alone grigio delle fotocopie).
*/

const ANALYSIS_WIDTH = 1400;
const STRIPS = 24;
const BANDS = 4;

/** Luminanza 0–255 di un buffer RGBA. */
function toGray(data, w, h) {
  const g = new Float32Array(w * h);
  for (let i = 0, p = 0; i < g.length; i++, p += 4) {
    g[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  }
  return g;
}

/** Riduzione a media di blocchi: veloce e senza aliasing. */
function downsample(gray, w, h, scale) {
  const aw = Math.max(1, Math.round(w * scale));
  const ah = Math.max(1, Math.round(h * scale));
  const out = new Float32Array(aw * ah);
  const fx = w / aw;
  const fy = h / ah;
  for (let y = 0; y < ah; y++) {
    const y0 = Math.floor(y * fy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * fy));
    for (let x = 0; x < aw; x++) {
      const x0 = Math.floor(x * fx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * fx));
      let sum = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) sum += gray[yy * w + xx];
      out[y * aw + x] = sum / ((y1 - y0) * (x1 - x0));
    }
  }
  return { gray: out, w: aw, h: ah };
}

/** Inchiostro con soglia locale (media su finestra via immagine integrale). */
function inkMap(gray, w, h) {
  const r = Math.max(8, Math.round(Math.min(w, h) / 40));
  const integral = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += gray[y * w + x];
      integral[(y + 1) * (w + 1) + x + 1] = integral[y * (w + 1) + x + 1] + row;
    }
  }
  const ink = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const ya = Math.max(0, y - r);
    const yb = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const xa = Math.max(0, x - r);
      const xb = Math.min(w, x + r + 1);
      const area = (yb - ya) * (xb - xa);
      const sum = integral[yb * (w + 1) + xb] - integral[ya * (w + 1) + xb]
        - integral[yb * (w + 1) + xa] + integral[ya * (w + 1) + xa];
      const mean = sum / area;
      const v = gray[y * w + x];
      ink[y * w + x] = v < mean * 0.85 && v < 200 ? 1 : 0;
    }
  }
  return ink;
}

function smooth(profile, radius) {
  const out = new Float32Array(profile.length);
  let acc = 0;
  for (let i = 0; i < profile.length + radius; i++) {
    if (i < profile.length) acc += profile[i];
    if (i - 2 * radius - 1 >= 0) acc -= profile[i - 2 * radius - 1];
    const c = i - radius;
    if (c >= 0 && c < profile.length) out[c] = acc;
  }
  return out;
}

/** Spostamento (in pixel) che meglio sovrappone b ad a, con il suo punteggio. */
function bestShift(a, b, y0, y1, maxShift) {
  let best = 0;
  let bestScore = -Infinity;
  let meanA = 0;
  let meanB = 0;
  for (let y = y0; y < y1; y++) {
    meanA += a[y];
    meanB += b[y];
  }
  meanA /= y1 - y0;
  meanB /= y1 - y0;
  const scores = [];
  for (let s = -maxShift; s <= maxShift; s++) {
    let num = 0;
    let da = 0;
    let db = 0;
    for (let y = y0; y < y1; y++) {
      const yb = y + s;
      if (yb < 0 || yb >= b.length) continue;
      const va = a[y] - meanA;
      const vb = b[yb] - meanB;
      num += va * vb;
      da += va * va;
      db += vb * vb;
    }
    const score = da && db ? num / Math.sqrt(da * db) : 0;
    scores.push(score);
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  // Raffinamento sub-pixel con la parabola sui tre punti attorno al massimo.
  const i = best + maxShift;
  if (i > 0 && i < scores.length - 1) {
    const l = scores[i - 1];
    const c = scores[i];
    const r = scores[i + 1];
    const den = l - 2 * c + r;
    if (den < 0) best += (0.5 * (l - r)) / den;
  }
  return { shift: best, score: bestScore };
}

/** Minimi quadrati pesati per un polinomio di grado `deg`. */
function polyfit(xs, ys, ws, deg) {
  const n = deg + 1;
  const A = Array.from({ length: n }, () => new Float64Array(n + 1));
  for (let k = 0; k < xs.length; k++) {
    const pw = [];
    for (let j = 0, v = 1; j < 2 * n; j++, v *= xs[k]) pw.push(v);
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) A[r][c] += ws[k] * pw[r + c];
      A[r][n] += ws[k] * pw[r] * ys[k];
    }
  }
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    if (Math.abs(A[c][c]) < 1e-12) return null;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k <= n; k++) A[r][k] -= f * A[c][k];
    }
  }
  return A.map((row, i) => row[n] / row[i]);
}

const evalPoly = (coef, x) => coef.reduce((acc, c, i) => acc + c * x ** i, 0);

/**
 * Stima il campo di spostamento verticale della pagina.
 * Pura: lavora su un buffer di grigi, si prova senza browser.
 *
 * @returns {{bands:Array<{y:number, coef:number[]}>, amplitude:number, confidence:number}|null}
 */
export function estimateWarp(gray, w, h) {
  const ink = inkMap(gray, w, h);

  // Area del testo: colonne e righe con inchiostro sufficiente.
  const colInk = new Float32Array(w);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) colInk[x] += ink[y * w + x];
  const colThreshold = h * 0.01;
  let left = 0;
  while (left < w && colInk[left] < colThreshold) left++;
  let right = w - 1;
  while (right > left && colInk[right] < colThreshold) right--;
  if (right - left < w * 0.3) return null;

  const stripW = (right - left) / STRIPS;
  const lineRadius = Math.max(1, Math.round(h / 400));
  const profiles = [];
  const stripInk = [];
  for (let k = 0; k < STRIPS; k++) {
    const x0 = Math.round(left + k * stripW);
    const x1 = Math.round(left + (k + 1) * stripW);
    const p = new Float32Array(h);
    let total = 0;
    for (let y = 0; y < h; y++) {
      let s = 0;
      for (let x = x0; x < x1; x++) s += ink[y * w + x];
      p[y] = s;
      total += s;
    }
    profiles.push(smooth(p, lineRadius));
    stripInk.push(total / ((x1 - x0) * h));
  }

  const maxStep = Math.max(2, Math.round(h * 0.012));
  const bandH = h / BANDS;
  const bands = [];
  let amplitude = 0;
  let confSum = 0;
  let confN = 0;
  for (let b = 0; b < BANDS; b++) {
    // Finestra un po' più larga della fascia: più righe = misura più stabile.
    const y0 = Math.max(0, Math.round(b * bandH - bandH * 0.25));
    const y1 = Math.min(h, Math.round((b + 1) * bandH + bandH * 0.25));
    const xs = [];
    const ys = [];
    const ws = [];
    // Riferimento: la striscia con più inchiostro della fascia.
    let ref = 0;
    let refInk = -1;
    for (let k = 0; k < STRIPS; k++) {
      let s = 0;
      for (let y = y0; y < y1; y++) s += profiles[k][y];
      if (s > refInk) {
        refInk = s;
        ref = k;
      }
    }
    if (refInk <= 0) continue;
    const cumulative = new Float64Array(STRIPS);
    const weight = new Float64Array(STRIPS);
    weight[ref] = 1;
    // Si procede a passi fra strisce VICINE: lo spostamento fra due strisce
    // adiacenti è piccolo, e non si confonde una riga con quella sotto.
    for (const dir of [1, -1]) {
      let acc = 0;
      let conf = 1;
      for (let k = ref + dir; k >= 0 && k < STRIPS; k += dir) {
        const prev = k - dir;
        const { shift, score } = bestShift(profiles[prev], profiles[k], y0, y1, maxStep);
        // Solo strisce con righe di testo nette: un'illustrazione o un margine
        // vuoto danno una correlazione bassa e falserebbero la curva.
        const usable = score > 0.55 && stripInk[k] > 0.004;
        if (usable) acc += shift;
        conf = usable ? Math.min(conf, score) : conf * 0.5;
        cumulative[k] = acc;
        weight[k] = usable ? conf : 0;
        if (usable) {
          confSum += score;
          confN++;
        }
      }
    }
    for (let k = 0; k < STRIPS; k++) {
      if (weight[k] <= 0) continue;
      xs.push((left + (k + 0.5) * stripW) / w);
      ys.push(cumulative[k]);
      ws.push(weight[k]);
    }
    if (xs.length < 6) continue;
    // La curva vale solo dove è stata misurata: oltre (es. accanto a una
    // figura) si tiene l'ultimo valore invece di estrapolare un polinomio
    // che lì schizzerebbe e deformerebbe la pagina.
    const xmin = Math.min(...xs);
    const xmax = Math.max(...xs);
    const coef = polyfit(xs, ys, ws, xmax - xmin > 0.5 ? 3 : 2);
    if (!coef) continue;
    // Spostamento medio nullo: la pagina non «scende», si raddrizza.
    let mean = 0;
    for (let i = 0; i <= 20; i++) mean += evalPoly(coef, xmin + (xmax - xmin) * (i / 20));
    coef[0] -= mean / 21;
    for (let i = 0; i <= 20; i++) {
      amplitude = Math.max(amplitude, Math.abs(evalPoly(coef, xmin + (xmax - xmin) * (i / 20))));
    }
    bands.push({ y: (y0 + y1) / 2 / h, coef, xmin, xmax });
  }
  if (bands.length < 2) return null;
  return { bands, amplitude, confidence: confN ? confSum / confN : 0, left: left / w, right: right / w };
}

/** Spostamento verticale (in frazione di altezza × h di analisi) nel punto (u,v) 0–1. */
function displacementAt(warp, u, v) {
  const { bands } = warp;
  const at = (band) => evalPoly(
    band.coef,
    Math.min(band.xmax ?? warp.right, Math.max(band.xmin ?? warp.left, u)),
  );
  if (v <= bands[0].y) return at(bands[0]);
  const last = bands[bands.length - 1];
  if (v >= last.y) return at(last);
  for (let i = 0; i < bands.length - 1; i++) {
    const a = bands[i];
    const b = bands[i + 1];
    if (v >= a.y && v <= b.y) {
      const t = (v - a.y) / (b.y - a.y);
      return at(a) * (1 - t) + at(b) * t;
    }
  }
  return 0;
}

/**
 * Rimappa un'immagine RGBA a piena risoluzione. Restituisce un nuovo buffer.
 * `scale` è il rapporto fra analisi e piena risoluzione.
 */
export function applyWarp(data, w, h, warp, scale) {
  const out = new Uint8ClampedArray(data.length);
  const grid = 8;
  const gw = Math.ceil(w / grid) + 1;
  const gh = Math.ceil(h / grid) + 1;
  const field = new Float32Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      field[gy * gw + gx] = displacementAt(warp, (gx * grid) / w, (gy * grid) / h) / scale;
    }
  }
  for (let y = 0; y < h; y++) {
    const gy = y / grid;
    const gy0 = Math.floor(gy);
    const ty = gy - gy0;
    for (let x = 0; x < w; x++) {
      const gx = x / grid;
      const gx0 = Math.floor(gx);
      const tx = gx - gx0;
      const i00 = gy0 * gw + gx0;
      const d = field[i00] * (1 - tx) * (1 - ty) + field[i00 + 1] * tx * (1 - ty)
        + field[i00 + gw] * (1 - tx) * ty + field[i00 + gw + 1] * tx * ty;
      const sy = y + d;
      const o = (y * w + x) * 4;
      if (sy < 0 || sy > h - 1) {
        out[o] = out[o + 1] = out[o + 2] = 255;
        out[o + 3] = 255;
        continue;
      }
      const y0 = Math.floor(sy);
      const y1 = Math.min(h - 1, y0 + 1);
      const t = sy - y0;
      const a = (y0 * w + x) * 4;
      const b = (y1 * w + x) * 4;
      out[o] = data[a] * (1 - t) + data[b] * t;
      out[o + 1] = data[a + 1] * (1 - t) + data[b + 1] * t;
      out[o + 2] = data[a + 2] * (1 - t) + data[b + 2] * t;
      out[o + 3] = 255;
    }
  }
  return out;
}

/** Contrasto: il grigio di fondo delle fotocopie torna bianco, il testo nero. */
export function normalizeContrast(data) {
  const hist = new Uint32Array(256);
  const n = data.length / 4;
  for (let p = 0; p < data.length; p += 4) {
    hist[Math.round(0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2])]++;
  }
  const at = (q) => {
    let acc = 0;
    for (let v = 0; v < 256; v++) {
      acc += hist[v];
      if (acc >= q * n) return v;
    }
    return 255;
  };
  const lo = at(0.005);
  // Il fondo pagina è la maggioranza dei pixel: il suo valore tipico è bianco.
  const hi = at(0.6);
  if (hi - lo < 60 || (lo < 12 && hi > 245)) return null;
  const out = new Uint8ClampedArray(data.length);
  const k = 255 / (hi - lo);
  for (let p = 0; p < data.length; p += 4) {
    out[p] = (data[p] - lo) * k;
    out[p + 1] = (data[p + 1] - lo) * k;
    out[p + 2] = (data[p + 2] - lo) * k;
    out[p + 3] = 255;
  }
  return out;
}

/**
 * Elabora un buffer RGBA: stima e corregge la curvatura, poi il contrasto.
 * @returns {{data:Uint8ClampedArray, changed:boolean, amplitude:number}}
 */
export function cleanPageBuffer(data, w, h, { dewarp = true, contrast = true } = {}) {
  let out = data;
  let changed = false;
  let amplitude = 0;
  if (dewarp) {
    const scale = Math.min(1, ANALYSIS_WIDTH / w);
    const small = downsample(toGray(data, w, h), w, h, scale);
    const warp = estimateWarp(small.gray, small.w, small.h);
    // Sotto 1,5 pixel di analisi la pagina è dritta: non si tocca.
    if (warp && warp.confidence > 0.45 && warp.amplitude > 1.5 && warp.amplitude < small.h * 0.08) {
      out = applyWarp(out, w, h, warp, scale);
      changed = true;
      amplitude = warp.amplitude / scale;
    }
  }
  if (contrast) {
    const fixed = normalizeContrast(out);
    if (fixed) {
      out = fixed;
      changed = true;
    }
  }
  return { data: out, changed, amplitude };
}

/**
 * Versione per il browser: data URL in ingresso, data URL in uscita.
 * Se qualcosa va storto restituisce la pagina originale.
 */
export async function cleanPageImage(dataUrl, options) {
  if (typeof document === 'undefined' && typeof OffscreenCanvas === 'undefined') return dataUrl;
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = reject;
      el.src = dataUrl;
    });
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const image = ctx.getImageData(0, 0, w, h);
    const res = cleanPageBuffer(image.data, w, h, options);
    if (!res.changed) return dataUrl;
    image.data.set(res.data);
    ctx.putImageData(image, 0, 0);
    return /^data:image\/jpe?g/i.test(dataUrl)
      ? canvas.toDataURL('image/jpeg', 0.92)
      : canvas.toDataURL('image/png');
  } catch {
    return dataUrl;
  }
}
