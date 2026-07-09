import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Il compilatore Typst WASM è ESM di grandi dimensioni: lo escludiamo dal
// pre-bundling di esbuild così Vite lo serve nativamente e le fetch dei .wasm
// (risolte via `?url`) restano coerenti.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  optimizeDeps: {
    exclude: [
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
