/*
  Pagina sintetica: righe di «parole» (rettangoli d'inchiostro) incurvate
  come vicino alla rilegatura. Dopo la correzione le righe devono essere
  dritte; una pagina già dritta non deve cambiare.
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanPageBuffer, estimateWarp } from '../src/lib/dewarp.js';

function page(w, h, warp) {
  const data = new Uint8ClampedArray(w * h * 4).fill(255);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let line = 0; line < 40; line++) {
    const base = 80 + line * 34;
    let x = 60;
    while (x < w - 60) {
      const len = 20 + Math.floor(rnd() * 60);
      for (let xx = x; xx < Math.min(w - 60, x + len); xx++) {
        const off = warp(xx / w, base / h);
        for (let t = 0; t < 12; t++) {
          const y = Math.round(base + t + off);
          if (y < 0 || y >= h) continue;
          const p = (y * w + xx) * 4;
          data[p] = data[p + 1] = data[p + 2] = 30;
        }
      }
      x += len + 12;
    }
  }
  return data;
}

const W = 1000;
const H = 1500;
const toGray = (d) => {
  const g = new Float32Array(W * H);
  for (let i = 0; i < g.length; i++) g[i] = d[i * 4];
  return g;
};

test('curvatura vicino alla rilegatura: le righe tornano dritte', () => {
  // Onda forte sul lato destro (rilegatura) più una leggera inclinazione.
  const bend = (u, v) => 26 * Math.max(0, u - 0.6) ** 2 / 0.16 * (0.6 + v) + 8 * u;
  const src = page(W, H, bend);
  const before = estimateWarp(toGray(src), W, H);
  const res = cleanPageBuffer(src, W, H, { contrast: false });
  assert.equal(res.changed, true);
  const after = estimateWarp(toGray(res.data), W, H);
  assert.ok(before.amplitude > 8, `curvatura misurata: ${before.amplitude}`);
  assert.ok(after.amplitude < before.amplitude * 0.3, `prima ${before.amplitude}, dopo ${after.amplitude}`);
});

test('una pagina dritta resta intatta', () => {
  const src = page(W, H, () => 0);
  const res = cleanPageBuffer(src, W, H, { contrast: false });
  assert.equal(res.changed, false);
});
