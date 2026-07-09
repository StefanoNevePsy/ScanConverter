/*
  Inizializzazione e uso del compilatore Typst in WebAssembly, interamente
  client-side. Nessun round-trip verso un server: il codice Typst viene
  compilato nel browser e restituisce un PDF vettoriale (Uint8Array) e/o un
  SVG per l'anteprima veloce.

  API verificata contro @myriaddreamin/typst.ts@0.7.0:
    - $typst.setCompilerInitOptions({ getModule, beforeBuild })
    - $typst.setRendererInitOptions({ getModule })
    - await $typst.pdf({ mainContent })  -> Uint8Array (byte del PDF)
    - await $typst.svg({ mainContent })  -> string (markup SVG)

  Font: di default il compilatore scarica i font da una CDN (jsdelivr). Qui
  li impacchettiamo localmente e passiamo un font-loader con `{ assets: false }`
  così il loader remoto NON viene aggiunto: l'app resta autosufficiente,
  senza dipendere dalla rete a runtime (niente sorprese di CORS/CSP/offline).
*/

import { $typst } from '@myriaddreamin/typst.ts/dist/esm/contrib/snippet.mjs';
import { loadFonts } from '@myriaddreamin/typst.ts/dist/esm/options.init.mjs';

// Vite risolve i binari WASM in URL statici serviti dall'app.
import compilerWasmUrl from '@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler_bg.wasm?url';
import rendererWasmUrl from '@myriaddreamin/typst-ts-renderer/pkg/typst_ts_renderer_bg.wasm?url';

// I font accademici impacchettati: Libertinus Serif + New Computer Modern
// (corpo serif), DejaVu Sans (titoli sans), DejaVu Sans Mono (monospazio).
// import.meta.glob li raccoglie tutti come URL statici same-origin.
const fontModules = import.meta.glob('../assets/fonts/*.{ttf,otf}', {
  eager: true,
  query: '?url',
  import: 'default',
});
const FONT_URLS = Object.values(fontModules);

let initPromise = null;

/**
 * Inizializza compilatore e renderer una sola volta (idempotente).
 * Le opzioni vanno impostate PRIMA della prima compilazione.
 */
export function initTypst() {
  if (!initPromise) {
    initPromise = (async () => {
      // $typst è un singleton condiviso: se un'altra istanza del modulo (es.
      // dopo un HMR) lo ha già configurato/inizializzato, i setter lanciano
      // "has been initialized". In quel caso la configurazione è già valida
      // e possiamo ignorare l'errore.
      try {
        $typst.setCompilerInitOptions({
          getModule: () => compilerWasmUrl,
          // `assets: false` disattiva il font-loader remoto di default.
          beforeBuild: [loadFonts(FONT_URLS, { assets: false })],
        });
        $typst.setRendererInitOptions({ getModule: () => rendererWasmUrl });
      } catch (e) {
        if (!/has been initialized/.test(String(e?.message))) throw e;
      }
      // Riscalda compilatore, renderer e cache font con una compilazione
      // minima: la prima compilazione "vera" risulta così istantanea.
      await $typst.svg({ mainContent: '#set page(width: 1pt, height: 1pt)\n' });
    })();
  }
  return initPromise;
}

/**
 * Compila il sorgente Typst in un PDF, incorporando eventuali figure.
 * @param {string} source codice Typst
 * @param {{path:string,bytes:Uint8Array}[]} [figures] immagini da rendere
 *        disponibili al compilatore (referenziate come `image("/figures/…")`)
 * @returns {Promise<Uint8Array>} byte del PDF
 */
export async function compileToPdf(source, figures = []) {
  await initTypst();
  // Rende disponibili le figure come "shadow file" nel filesystem virtuale
  // del compilatore. mapShadow sovrascrive: ri-compilazioni idempotenti.
  for (const fig of figures) {
    if (fig?.path && fig?.bytes) await $typst.mapShadow(fig.path, fig.bytes);
  }
  const bytes = await $typst.pdf({ mainContent: source });
  if (!bytes || !bytes.length) {
    throw new Error('Il compilatore Typst non ha prodotto alcun output PDF.');
  }
  return bytes;
}

/**
 * Compila il sorgente Typst in SVG (anteprima veloce, senza generare il PDF).
 * @param {string} source codice Typst
 * @returns {Promise<string>} markup SVG
 */
export async function compileToSvg(source) {
  await initTypst();
  return $typst.svg({ mainContent: source });
}

/**
 * Crea un object URL a partire dai byte del PDF, per <iframe> o download.
 * Il chiamante è responsabile della revoca (URL.revokeObjectURL).
 * @param {Uint8Array} bytes
 * @returns {string} blob URL
 */
export function pdfObjectUrl(bytes) {
  const blob = new Blob([bytes], { type: 'application/pdf' });
  return URL.createObjectURL(blob);
}
