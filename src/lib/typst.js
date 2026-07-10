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
async function prepare(source, figures) {
  await initTypst();
  // Pre-controllo: titoli Markdown non convertiti (`## Titolo`). In Typst `#`
  // seguito da spazio non è mai valido → messaggio chiaro invece del criptico
  // "the character `#` is not valid in code".
  const md = source.match(/^[ \t]{0,3}(#{1,6})[ \t]+\S[^\n]*/m);
  if (md) {
    const eq = '='.repeat(md[1].length);
    throw new Error(
      `Titolo Markdown non convertito: «${md[0].trim().slice(0, 40)}…». In ` +
        `Typst i titoli usano "=" invece di "#": scrivi «${eq} …» al posto di ` +
        `«${md[1]} …».`,
    );
  }
  // Rende disponibili le figure come "shadow file" nel filesystem virtuale
  // del compilatore. mapShadow sovrascrive: ri-compilazioni idempotenti.
  for (const fig of figures || []) {
    if (fig?.path && fig?.bytes) await $typst.mapShadow(fig.path, fig.bytes);
  }
}

export async function compileToPdf(source, figures = []) {
  await prepare(source, figures);
  let bytes;
  try {
    bytes = await $typst.pdf({ mainContent: source });
  } catch (e) {
    throw new Error(formatTypstError(e));
  }
  if (!bytes || !bytes.length) {
    throw new Error('Il compilatore Typst non ha prodotto alcun output PDF.');
  }
  return bytes;
}

/**
 * Il compilatore Typst lancia una stringa in stile Rust-debug
 * (`[SourceDiagnostic { … message: "…", hints: […] }]`). La trasformiamo in
 * un messaggio leggibile con i messaggi d'errore reali (e gli eventuali hint).
 */
export function formatTypstError(err) {
  const raw = typeof err === 'string' ? err : err?.message || String(err);
  if (!raw || !raw.includes('SourceDiagnostic')) {
    return err?.message || raw || 'Errore di compilazione Typst.';
  }
  const messages = [...raw.matchAll(/message:\s*"((?:[^"\\]|\\.)*)"/g)].map((m) =>
    m[1].replace(/\\"/g, '"').replace(/\\n/g, ' ').trim(),
  );
  const hints = [...raw.matchAll(/hints:\s*\[\s*"((?:[^"\\]|\\.)*)"/g)].map((m) =>
    m[1].replace(/\\"/g, '"').trim(),
  );
  if (!messages.length) return raw.slice(0, 300);
  let out = messages.join(' · ');
  if (hints.length) out += ` (suggerimento: ${hints.join('; ')})`;
  return out;
}

/**
 * Compila il sorgente Typst in SVG (usato per l'anteprima: si renderizza in
 * qualsiasi browser/WebView, anche su Android dove l'<iframe> PDF resta bianco).
 * @param {string} source codice Typst
 * @param {{path:string,bytes:Uint8Array}[]} [figures]
 * @returns {Promise<string>} markup SVG
 */
export async function compileToSvg(source, figures = []) {
  await prepare(source, figures);
  try {
    const svg = await $typst.svg({ mainContent: source });
    if (!svg) throw new Error('Il compilatore Typst non ha prodotto SVG.');
    return svg;
  } catch (e) {
    throw new Error(formatTypstError(e));
  }
}

/**
 * Localizza un errore di compilazione per BISEZIONE: gli errori di Typst non
 * riportano la riga (gli span sono id opachi), così su un documento lungo un
 * «unclosed delimiter» è introvabile. Qui si compilano prefissi crescenti di
 * paragrafi col compilatore locale (gratis) e si trova il primo blocco che fa
 * fallire la compilazione: riga e snippet da mostrare all'utente e da passare
 * alla correzione AI.
 *
 * @param {string} source codice Typst che NON compila
 * @param {{path:string,bytes:Uint8Array}[]} [figures]
 * @returns {Promise<{line:number,snippet:string}|null>} null se non localizzabile
 */
export async function locateTypstError(source, figures = []) {
  try {
    await initTypst();
    for (const fig of figures || []) {
      if (fig?.path && fig?.bytes) await $typst.mapShadow(fig.path, fig.bytes);
    }
    // Paragrafi con la loro riga di partenza (1-based).
    const paras = [];
    let line = 1;
    for (const part of source.split('\n\n')) {
      paras.push({ text: part, line });
      line += part.split('\n').length + 1;
    }
    if (paras.length < 2) return null;

    const compiles = async (src) => {
      try {
        return !!(await $typst.svg({ mainContent: src }));
      } catch {
        return false;
      }
    };
    const prefix = (k) => paras.slice(0, k + 1).map((p) => p.text).join('\n\n');

    // Primo indice k il cui prefisso non compila (bisezione: ~log2(N) compile).
    let lo = 0;
    let hi = paras.length - 1;
    if (await compiles(prefix(hi))) return null; // in realtà compila
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (await compiles(prefix(mid))) lo = mid + 1;
      else hi = mid;
    }
    const p = paras[lo];
    return { line: p.line, snippet: p.text.trim().replace(/\s+/g, ' ').slice(0, 140) };
  } catch {
    return null; // best-effort: la localizzazione non deve mai bloccare
  }
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
