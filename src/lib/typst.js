/*
  Inizializzazione e uso del compilatore Typst in WebAssembly, interamente
  client-side. Nessun round-trip verso un server: il codice Typst viene
  compilato nel browser e restituisce un PDF vettoriale (Uint8Array) e/o un
  SVG per l'anteprima veloce.

  API verificata contro @myriaddreamin/typst.ts@0.7.0:
    - $typst.setCompilerInitOptions({ getModule, beforeBuild })
    - $typst.setRendererInitOptions({ getModule })
    - compiler.compile({ diagnostics: "full" }) -> artefatto + riga/colonna
    - await $typst.svg({ vectorData }) -> string (markup SVG)

  Font: di default il compilatore scarica i font da una CDN (jsdelivr). Qui
  li impacchettiamo localmente e passiamo un font-loader con `{ assets: false }`
  così il loader remoto NON viene aggiunto: l'app resta autosufficiente,
  senza dipendere dalla rete a runtime (niente sorprese di CORS/CSP/offline).
*/

import { $typst } from '@myriaddreamin/typst.ts/dist/esm/contrib/snippet.mjs';
import { CompileFormatEnum } from '@myriaddreamin/typst.ts/compiler';
import { loadFonts } from '@myriaddreamin/typst.ts/dist/esm/options.init.mjs';
import {
  formatTypstDiagnostics,
  normalizeTypstDiagnostics,
} from './typstdiag.js';
import { compileWithNativeTypst, hasNativeTypstEngine } from './desktop.js';

export { normalizeTypstDiagnostics, parseTypstRange } from './typstdiag.js';

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
let compileQueue = Promise.resolve();
const MAIN_SOURCE_PATH = '/scanconverter/main.typ';

// Il compilatore e il renderer di `$typst` sono singleton mutabili. Le
// compilazioni dell'editor, della ricerca e del correttore possono partire
// quasi insieme: serializzarle evita che un reset/addSource sostituisca il
// documento mentre un'altra operazione lo sta ancora usando.
function serializedCompile(task) {
  const run = compileQueue.catch(() => {}).then(task);
  compileQueue = run.catch(() => {});
  return run;
}

/**
 * Inizializza compilatore e renderer una sola volta (idempotente).
 * Le opzioni vanno impostate PRIMA della prima compilazione.
 */
function initWasmTypst() {
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
 * Sul desktop il warm-up del grosso compilatore WASM non serve: il binario
 * Typst viene inizializzato nel processo isolato alla prima richiesta. Web e
 * Android mantengono invece esattamente il backend precedente.
 */
let lastEngine = '';

/** Compilatore usato per l'ultimo PDF: 'native', 'wasm' o '' se nessuno. */
export function lastTypstEngine() {
  return lastEngine;
}

export async function initTypst() {
  if (await hasNativeTypstEngine()) return;
  await initWasmTypst();
}

/**
 * Compila il sorgente Typst in un PDF, incorporando eventuali figure.
 * @param {string} source codice Typst
 * @param {{path:string,bytes:Uint8Array}[]} [figures] immagini da rendere
 *        disponibili al compilatore (referenziate come `image("/figures/…")`)
 * @returns {Promise<Uint8Array>} byte del PDF
 */
function validateSource(source) {
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
}

async function prepareFigures(figures) {
  // Rende disponibili le figure come "shadow file" nel filesystem virtuale
  // del compilatore. mapShadow sovrascrive: ri-compilazioni idempotenti.
  for (const fig of figures || []) {
    if (fig?.path && fig?.bytes) await $typst.mapShadow(fig.path, fig.bytes);
  }
}

function compileError(diagnostics, fallback) {
  const error = new Error(formatTypstDiagnostics(diagnostics) || formatTypstError(fallback));
  error.name = 'TypstCompileError';
  error.diagnostics = diagnostics;
  return error;
}

async function compileWasmArtifact(source, figures, format = CompileFormatEnum.vector) {
  validateSource(source);
  await initWasmTypst();
  await prepareFigures(figures);
  const compiler = await $typst.getCompiler();
  await compiler.reset();
  compiler.addSource(MAIN_SOURCE_PATH, source);
  let result;
  try {
    result = await compiler.compile({
      mainFilePath: MAIN_SOURCE_PATH,
      format,
      diagnostics: 'full',
    });
  } catch (error) {
    const diagnostics = normalizeTypstDiagnostics(error?.diagnostics || error?.message || error);
    throw compileError(diagnostics, error);
  }
  const diagnostics = normalizeTypstDiagnostics(result?.diagnostics);
  if (!result?.result) throw compileError(diagnostics, 'Errore di compilazione Typst.');
  return { artifact: result.result, diagnostics };
}

async function compileNativeArtifact(source, figures, diagnoseOnly) {
  validateSource(source);
  const result = await compileWithNativeTypst(source, figures, diagnoseOnly);
  if (result == null) return null;
  const diagnostics = normalizeTypstDiagnostics(result.diagnostics);
  if (!result.ok) throw compileError(diagnostics, result.error);
  return { artifact: result.artifact || null, diagnostics };
}

/**
 * Controlla sintassi e semantica senza renderizzare: è il percorso economico
 * usato dal correttore per provare molte patch su documenti molto lunghi.
 */
export async function diagnoseTypst(source, figures = []) {
  return serializedCompile(async () => {
    try {
      const native = await compileNativeArtifact(source, figures, true);
      const compiled = native || await compileWasmArtifact(source, figures);
      return { ok: true, diagnostics: compiled.diagnostics };
    } catch (error) {
      return {
        ok: false,
        diagnostics: normalizeTypstDiagnostics(error?.diagnostics || error?.message || error),
        error: error?.message || String(error),
      };
    }
  });
}

export async function compileToPdf(source, figures = []) {
  const { artifact } = await serializedCompile(async () => {
    const native = await compileNativeArtifact(source, figures, false);
    // Quale compilatore ha lavorato davvero: sul desktop il binario nativo, sul
    // web il WASM. Il ripiego è silenzioso di proposito — ma se è silenzioso
    // anche verso l'utente, non si può sapere se il nativo stia funzionando.
    lastEngine = native ? 'native' : 'wasm';
    return native || compileWasmArtifact(source, figures, CompileFormatEnum.pdf);
  });
  if (!artifact || (!artifact.length && artifact.kind !== 'desktop-pdf')) {
    throw new Error('Il compilatore Typst non ha prodotto alcun output PDF.');
  }
  return artifact;
}

/**
 * Il compilatore Typst lancia una stringa in stile Rust-debug
 * (`[SourceDiagnostic { … message: "…", hints: […] }]`). La trasformiamo in
 * un messaggio leggibile con i messaggi d'errore reali (e gli eventuali hint).
 */
export function formatTypstError(err) {
  const structured = normalizeTypstDiagnostics(err?.diagnostics);
  if (structured.length) return formatTypstDiagnostics(structured);
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
  return serializedCompile(async () => {
    const { artifact } = await compileWasmArtifact(source, figures);
    try {
      // Riusa l'artefatto vettoriale appena validato: nessuna seconda
      // compilazione del sorgente prima del rendering SVG.
      const svg = await $typst.svg({ vectorData: artifact });
      if (!svg) throw new Error('Il compilatore Typst non ha prodotto SVG.');
      return svg;
    } catch (e) {
      throw new Error(formatTypstError(e));
    }
  });
}

/**
 * Localizza un errore usando prima le diagnostiche strutturate del compilatore
 * (`riga:colonna`). Solo per i rari errori del wrapper privi di range usa una
 * bisezione di prefissi; il chiamante riceve riga e snippet da mostrare e da
 * passare alla correzione AI.
 *
 * @param {string} source codice Typst che NON compila
 * @param {{path:string,bytes:Uint8Array}[]} [figures]
 * @returns {Promise<{line:number,snippet:string}|null>} null se non localizzabile
 */
export async function locateTypstError(source, figures = []) {
  try {
    // Il formato diagnostico "full" del compilatore contiene già
    // riga/colonna. Una sola compilazione sostituisce normalmente tutta la
    // vecchia bisezione.
    const direct = await diagnoseTypst(source, figures);
    if (direct.ok) return null;
    const first = direct.diagnostics.find((diag) => diag.severity === 'error') || direct.diagnostics[0];
    if (first?.line) {
      const lines = String(source || '').split('\n');
      const snippet = lines
        .slice(Math.max(0, first.line - 2), Math.min(lines.length, first.line + 1))
        .join(' ')
        .trim()
        .replace(/\s+/g, ' ')
        .slice(0, 140);
      return {
        line: first.line,
        column: first.column,
        endLine: first.endLine,
        endColumn: first.endColumn,
        snippet,
        message: first.message,
      };
    }

    // Fallback per diagnostiche prive di range (errori del wrapper/runtime).
    // Paragrafi con la loro riga di partenza (1-based).
    const paras = [];
    let line = 1;
    for (const part of source.split('\n\n')) {
      paras.push({ text: part, line });
      line += part.split('\n').length + 1;
    }
    if (paras.length < 2) return null;

    const compiles = async (src) => {
      const result = await diagnoseTypst(src, figures);
      return result.ok;
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
