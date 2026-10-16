import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

// Motore ONNX per il modello di impaginazione: i suoi .wasm devono essere
// serviti come file statici (public/ort), sia in sviluppo sia nella build.
// Copiati da node_modules a ogni avvio: niente binari nel repository.
function copyOnnxRuntime() {
  return {
    name: 'copy-onnxruntime',
    buildStart() {
      const from = resolve('node_modules/onnxruntime-web/dist');
      const to = resolve('public/ort');
      if (!existsSync(from)) return;
      mkdirSync(to, { recursive: true });
      for (const file of ['ort-wasm-simd-threaded.jsep.wasm', 'ort-wasm-simd-threaded.jsep.mjs']) {
        if (existsSync(resolve(from, file))) copyFileSync(resolve(from, file), resolve(to, file));
      }
    },
  };
}

// Il compilatore Typst WASM è ESM di grandi dimensioni: lo escludiamo dal
// pre-bundling di esbuild così Vite lo serve nativamente e le fetch dei .wasm
// (risolte via `?url`) restano coerenti.
export default defineConfig({
  // Percorso base degli asset. In locale e nell'app Android è la radice ("/");
  // su GitHub Pages il sito vive in un sottopercorso (es. "/ScanConverter/"),
  // impostato dalla GitHub Action tramite la variabile VITE_BASE. Tutti gli
  // asset (?url, BASE_URL) vengono così risolti in modo coerente.
  base: process.env.VITE_BASE || '/',
  plugins: [copyOnnxRuntime(), react(), tailwindcss()],
  optimizeDeps: {
    exclude: [
      'onnxruntime-web',
      '@myriaddreamin/typst.ts',
      '@myriaddreamin/typst-ts-web-compiler',
      '@myriaddreamin/typst-ts-renderer',
    ],
  },
  // NVIDIA NIM non espone header CORS: dal browser la chiamata diretta è
  // bloccata. In sviluppo la instradiamo tramite il dev server (server-side,
  // niente CORS). In produzione web serve un proxy analogo; nell'app Android
  // il problema non esiste (CapacitorHttp usa HTTP nativo).
  server: {
    proxy: {
      '/__nvidia__': {
        target: 'https://integrate.api.nvidia.com',
        changeOrigin: true,
        secure: true,
        rewrite: (p) => p.replace(/^\/__nvidia__/, ''),
      },
      // Gemini supporta il CORS (funziona diretto dal browser), ma il proxy
      // in dev aiuta reti/browser restrittivi ed è simmetrico a NVIDIA.
      '/__gemini__': {
        target: 'https://generativelanguage.googleapis.com',
        changeOrigin: true,
        secure: true,
        rewrite: (p) => p.replace(/^\/__gemini__/, ''),
      },
    },
  },
});
