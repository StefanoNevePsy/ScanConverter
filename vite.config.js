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
});
