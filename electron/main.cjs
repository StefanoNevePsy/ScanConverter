/*
  Processo principale di ScanConverter Desktop (Electron).

  CORS: su Mac/Windows come su Android il nodo è il CORS. NVIDIA NIM non invia
  gli header CORS, quindi da un browser statico le chiamate sono bloccate. Qui
  — come CapacitorHttp sul nativo Android — intercettiamo le risposte remote e
  iniettiamo gli header CORS mancanti (incluso il preflight). Così OCR NVIDIA,
  elenco modelli e motori NVIDIA/GLM/DeepSeek funzionano come Gemini.

  ORIGINE STABILE: l'app viene servita da uno scheme dedicato `app://` con host
  fisso, NON da un server http su porta casuale. localStorage e IndexedDB sono
  legati all'origine (scheme+host+porta): con una porta random cambierebbero a
  ogni avvio e impostazioni/sessioni salvate risulterebbero perse. Con
  `app://scanconverter` l'origine è costante e i dati persistono tra le
  sessioni. Lo scheme è privilegiato (standard+secure+fetch) così gli asset,
  i WASM e i worker si caricano come sul web.
*/
const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  protocol,
  session,
  shell,
  utilityProcess,
} = require('electron');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');

// La dist buildata è impacchettata accanto a questo file (vedi "files" in
// package.json → electron-builder). In sviluppo (`electron .`) è ../dist.
const DIST = path.join(__dirname, '..', 'dist');
const SCHEME = 'app';
const ORIGIN = `${SCHEME}://scanconverter`;

let mainWindow = null;
let typstEngine = null;
let typstEngineSpawn = null;
let typstWorkRoot = null;
let typstPdfCacheRoot = null;
const typstRequests = new Map();
const nativePdfs = new Map();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.words': 'text/plain; charset=utf-8',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.pdf': 'application/pdf',
};

function trustedRenderer(event) {
  return String(event?.senderFrame?.url || '').startsWith(`${ORIGIN}/`);
}

function assertTrustedRenderer(event) {
  if (!trustedRenderer(event)) throw new Error('Richiesta desktop non autorizzata.');
}

function nativeTypstPath() {
  const executable = process.platform === 'win32' ? 'typst.exe' : 'typst';
  const target = `${process.platform}-${process.arch}`;
  const candidates = [
    process.env.SCANCONVERTER_TYPST_PATH,
    app.isPackaged && path.join(process.resourcesPath, 'typst', target, executable),
    path.join(__dirname, '..', 'native', 'typst', target, executable),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function bundledFontsPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'fonts')
    : path.join(__dirname, '..', 'src', 'assets', 'fonts');
}

function typstEngineModulePath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'native-engine', 'typst-engine.cjs')
    : path.join(__dirname, 'typst-engine.cjs');
}

function rejectTypstRequests(message) {
  for (const { resolve } of typstRequests.values()) {
    resolve({ ok: false, infrastructure: true, diagnostics: [], error: message });
  }
  typstRequests.clear();
}

async function startTypstEngine() {
  if (typstEngine?.pid) return typstEngine;
  if (typstEngineSpawn) return typstEngineSpawn;
  const executable = nativeTypstPath();
  if (!executable) return null;

  typstEngineSpawn = new Promise((resolve) => {
    if (!typstWorkRoot) {
      typstWorkRoot = fs.mkdtempSync(path.join(app.getPath('temp'), 'scanconverter-typst-'));
    }
    if (!typstPdfCacheRoot) {
      const setup = readLocalSetup();
      // Se l'utente ha scelto un disco esterno per il motore locale, anche i
      // PDF potenzialmente grandi restano lì; altrimenti si usa userData.
      typstPdfCacheRoot = setup.found && setup.rootAvailable
        ? path.join(setup.root, 'cache', 'typst-pdf')
        : path.join(app.getPath('userData'), 'typst-pdf-cache');
    }
    const config = Buffer.from(JSON.stringify({
      typstPath: executable,
      workRoot: typstWorkRoot,
      fontsDir: bundledFontsPath(),
      packageCachePath: path.join(app.getPath('userData'), 'typst-packages'),
      pdfCacheRoot: typstPdfCacheRoot,
      cacheVersion: 'typst-0.15.1-v1',
    }), 'utf8').toString('base64');
    const engineModule = typstEngineModulePath();
    let child;
    try {
      child = utilityProcess.fork(engineModule, [config], {
        cwd: path.dirname(engineModule),
        stdio: 'pipe',
        serviceName: 'ScanConverter Typst Engine',
      });
    } catch (error) {
      console.error(`Impossibile avviare il processo Typst: ${error.message}`);
      queueMicrotask(() => { typstEngineSpawn = null; });
      resolve(null);
      return;
    }
    typstEngine = child;
    let spawned = false;
    const spawnTimer = setTimeout(() => {
      if (spawned) return;
      child.kill();
      if (typstEngine === child) typstEngine = null;
      typstEngineSpawn = null;
      resolve(null);
    }, 10_000);
    spawnTimer.unref?.();
    child.once('spawn', () => {
      spawned = true;
      clearTimeout(spawnTimer);
      typstEngineSpawn = null;
      resolve(child);
    });
    child.on('message', (message) => {
      const pending = typstRequests.get(message?.id);
      if (!pending) return;
      typstRequests.delete(message.id);
      pending.resolve(message);
    });
    child.on('exit', (code) => {
      clearTimeout(spawnTimer);
      if (typstEngine === child) typstEngine = null;
      typstEngineSpawn = null;
      rejectTypstRequests(`Il motore Typst nativo si è chiuso (codice ${code}).`);
      if (!spawned) resolve(null);
    });
    child.on('error', (type, location) => {
      rejectTypstRequests(`Errore del motore Typst nativo: ${type}${location ? ` (${location})` : ''}.`);
    });
    child.stderr?.on('data', (chunk) => {
      const message = chunk.toString('utf8').trim();
      if (message) console.error(`[typst-engine] ${message}`);
    });
  });
  return typstEngineSpawn;
}

async function requestTypstEngine(request) {
  const child = await startTypstEngine();
  if (!child) {
    return {
      ok: false,
      infrastructure: true,
      diagnostics: [],
      error: 'Il binario Typst nativo non è incluso in questa build.',
    };
  }
  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    typstRequests.set(id, { resolve });
    try {
      child.postMessage({ ...request, id });
    } catch (error) {
      typstRequests.delete(id);
      resolve({ ok: false, infrastructure: true, diagnostics: [], error: error.message });
    }
  });
}

function registerNativePdf(pdfPath, size, persistent = false) {
  const resolved = path.resolve(pdfPath);
  const inWorkRoot = typstWorkRoot && resolved.startsWith(`${path.resolve(typstWorkRoot)}${path.sep}`);
  const inCacheRoot = typstPdfCacheRoot && resolved.startsWith(`${path.resolve(typstPdfCacheRoot)}${path.sep}`);
  if (!inWorkRoot && !inCacheRoot) {
    throw new Error('Il motore Typst ha restituito un percorso PDF non sicuro.');
  }
  const id = crypto.randomUUID();
  nativePdfs.set(id, {
    path: resolved,
    size: Number(size) || 0,
    persistent: Boolean(persistent && inCacheRoot),
    releaseTimer: null,
  });
  return {
    kind: 'desktop-pdf',
    id,
    size: Number(size) || 0,
    url: `${ORIGIN}/__native_pdf/${id}`,
  };
}

function parseByteRange(value, size) {
  const match = String(value || '').match(/^bytes=(\d*)-(\d*)$/i);
  if (!match || (!match[1] && !match[2])) return null;
  let start;
  let end;
  if (!match[1]) {
    const suffix = Math.min(size, Number(match[2]) || 0);
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) {
    return { invalid: true };
  }
  return { start, end: Math.min(end, size - 1) };
}

async function serveNativePdf(request, pathname) {
  const id = pathname.slice('/__native_pdf/'.length).split('/')[0];
  const artifact = nativePdfs.get(id);
  if (!artifact) return new Response('PDF non disponibile', { status: 404 });
  let stat;
  try {
    stat = await fs.promises.stat(artifact.path);
  } catch {
    nativePdfs.delete(id);
    return new Response('PDF non disponibile', { status: 404 });
  }
  const size = stat.size;
  const range = parseByteRange(request.headers.get('range'), size);
  if (range?.invalid) {
    return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? Math.max(0, size - 1);
  const headers = {
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
    'content-length': String(Math.max(0, end - start + 1)),
    'content-type': 'application/pdf',
  };
  if (range) headers['content-range'] = `bytes ${start}-${end}/${size}`;
  if (request.method === 'HEAD') return new Response(null, { status: range ? 206 : 200, headers });
  const stream = fs.createReadStream(artifact.path, { start, end });
  return new Response(Readable.toWeb(stream), { status: range ? 206 : 200, headers });
}

function pdfFileName(value) {
  let name = path.basename(String(value || 'documento.pdf'))
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .trim();
  if (!name) name = 'documento.pdf';
  return name.toLowerCase().endsWith('.pdf') ? name : `${name}.pdf`;
}


/*
  Esito dell'installazione locale, scritto dagli script in tools/setup.

  Lo script sa dove ha messo le cose; l'app no, e finora l'utente doveva
  ridigitare gli indirizzi a mano. Il file contiene soltanto percorsi e
  indirizzi locali — nessuna chiave, nessun dato dei documenti — e viene
  letto in sola lettura all'avvio.
*/
function localSetupCandidates() {
  const parent = path.dirname(app.getPath('userData'));
  return [
    // In sviluppo il nome dell'app è minuscolo e non coincide con quello
    // che gli script usano: si guardano entrambi.
    path.join(app.getPath('userData'), 'local-setup.json'),
    path.join(parent, 'ScanConverter', 'local-setup.json'),
  ];
}

function readLocalSetup() {
  for (const candidate of localSetupCandidates()) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      if (parsed?.schemaVersion !== 1) continue;
      return {
        found: true,
        path: candidate,
        root: String(parsed.root || ''),
        model: String(parsed.model || ''),
        translationModel: String(parsed.translationModel || ''),
        components: String(parsed.components || ''),
        localEndpoint: String(parsed.localEndpoint || ''),
        localOcrEndpoint: String(parsed.localOcrEndpoint || ''),
        typstPath: String(parsed.typstPath || ''),
        // Un disco esterno scollegato è il caso normale, non un errore:
        // l'app deve poterlo dire invece di fallire senza spiegazioni.
        rootAvailable: Boolean(parsed.root) && fs.existsSync(String(parsed.root)),
      };
    } catch {
      /* assente o illeggibile: si prova il candidato successivo */
    }
  }
  return { found: false };
}

function registerDesktopIpc() {
  ipcMain.handle('desktop:local-setup', async (event) => {
    assertTrustedRenderer(event);
    return readLocalSetup();
  });

  // Scegliere una cartella a mano è penoso e sbagliarla costa un download
  // da gigabyte: sul desktop si apre il selettore di sistema.
  ipcMain.handle('desktop:choose-folder', async (event) => {
    assertTrustedRenderer(event);
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Dove installare gli accessori locali',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths?.length) return { cancelled: true };
    return { cancelled: false, path: result.filePaths[0] };
  });

  ipcMain.handle('desktop:capabilities', async (event) => {
    assertTrustedRenderer(event);
    return {
      desktop: true,
      nativeTypst: Boolean(nativeTypstPath()),
      nativeTypstVersion: '0.15.1',
    };
  });
  ipcMain.handle('desktop:typst:compile', async (event, request) => {
    assertTrustedRenderer(event);
    if (!request || typeof request.source !== 'string') {
      return { ok: false, infrastructure: true, diagnostics: [], error: 'Richiesta Typst non valida.' };
    }
    const result = await requestTypstEngine(request);
    if (!result.ok || !result.pdfPath) return result;
    try {
      const artifact = registerNativePdf(result.pdfPath, result.size, result.persistent);
      const { pdfPath: _privatePath, ...safeResult } = result;
      return { ...safeResult, artifact };
    } catch (error) {
      return { ok: false, infrastructure: true, diagnostics: [], error: error.message };
    }
  });
  ipcMain.handle('desktop:typst:prepare-figures', async (event, request) => {
    assertTrustedRenderer(event);
    if (!request || typeof request.figureSetId !== 'string') {
      return { ok: false, infrastructure: true, diagnostics: [], error: 'Progetto figure non valido.' };
    }
    return requestTypstEngine({ ...request, operation: 'prepareFigureSet' });
  });
  ipcMain.handle('desktop:pdf:save', async (event, request) => {
    assertTrustedRenderer(event);
    const artifact = nativePdfs.get(String(request?.id || ''));
    if (!artifact) throw new Error('Il PDF compilato non è più disponibile.');
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Salva PDF',
      defaultPath: pdfFileName(request?.fileName),
      filters: [{ name: 'Documento PDF', extensions: ['pdf'] }],
    });
    if (result.canceled || !result.filePath) return { cancelled: true };
    await fs.promises.copyFile(artifact.path, result.filePath);
    return { cancelled: false };
  });
  ipcMain.handle('desktop:pdf:release', async (event, request) => {
    assertTrustedRenderer(event);
    const id = String(request?.id || '');
    const artifact = nativePdfs.get(id);
    if (!artifact) return { released: false };
    if (!artifact.releaseTimer) {
      artifact.releaseTimer = setTimeout(() => {
        nativePdfs.delete(id);
        if (!artifact.persistent) fs.promises.rm(artifact.path, { force: true }).catch(() => {});
      }, 30_000);
      artifact.releaseTimer.unref?.();
    }
    return { released: true };
  });
}

function shutdownTypstEngine() {
  typstEngine?.kill();
  typstEngine = null;
  rejectTypstRequests('L’applicazione si sta chiudendo.');
  for (const artifact of nativePdfs.values()) clearTimeout(artifact.releaseTimer);
  nativePdfs.clear();
  if (typstWorkRoot) {
    const root = path.resolve(typstWorkRoot);
    const temp = path.resolve(app.getPath('temp'));
    if (root.startsWith(`${temp}${path.sep}`) && path.basename(root).startsWith('scanconverter-typst-')) {
      try {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      } catch (error) {
        console.warn(`Pulizia cache Typst rinviata: ${error.message}`);
      }
    }
    typstWorkRoot = null;
  }
}

// Deve avvenire PRIMA di app.ready: registra `app` come scheme privilegiato
// (origine propria, contesto sicuro, fetch e stream abilitati).
protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

/** Serve i file della dist sullo scheme app:// (con fallback SPA su index.html). */
function serveApp() {
  protocol.handle(SCHEME, async (request) => {
    let pathname = '/';
    try {
      pathname = decodeURIComponent(new URL(request.url).pathname);
    } catch {
      /* usa "/" */
    }
    if (pathname.startsWith('/__native_pdf/')) return serveNativePdf(request, pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';
    const filePath = path.normalize(path.join(DIST, pathname));
    if (!filePath.startsWith(DIST)) {
      return new Response('forbidden', { status: 403 });
    }
    try {
      const data = await fs.promises.readFile(filePath);
      return new Response(data, {
        headers: { 'content-type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' },
      });
    } catch {
      // Percorso ignoto → index.html (SPA).
      const html = await fs.promises.readFile(path.join(DIST, 'index.html'));
      return new Response(html, { headers: { 'content-type': MIME['.html'] } });
    }
  });
}

/**
 * Aggiunge gli header CORS alle risposte remote (https), incluso il preflight
 * OPTIONS che NVIDIA lascia senza header. Non tocca lo scheme app:// locale.
 */
function enableCorsBypass() {
  session.defaultSession.webRequest.onHeadersReceived({ urls: ['https://*/*'] }, (details, cb) => {
    const headers = details.responseHeaders || {};
    for (const k of Object.keys(headers)) {
      if (/^access-control-allow-(origin|methods|headers)$/i.test(k)) delete headers[k];
    }
    headers['Access-Control-Allow-Origin'] = ['*'];
    headers['Access-Control-Allow-Methods'] = ['GET,POST,PUT,DELETE,PATCH,OPTIONS'];
    headers['Access-Control-Allow-Headers'] = ['authorization,content-type,x-goog-api-key,accept'];
    cb({ responseHeaders: headers });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 560,
    backgroundColor: '#111317',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
      spellcheck: false,
    },
  });

  // I link esterni (es. documentazione) si aprono nel browser di sistema.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Smoke test end-to-end usato localmente/CI: attraversa preload, IPC,
  // utility process, Typst nativo e lettura Range del protocollo PDF.
  if (process.env.SCANCONVERTER_DESKTOP_SMOKE === '1' || process.argv.includes('--desktop-smoke')) {
    mainWindow.webContents.once('did-finish-load', async () => {
      try {
        const result = await mainWindow.webContents.executeJavaScript(`(async () => {
          const capabilities = await window.scanConverterDesktop.capabilities();
          if (!capabilities.nativeTypst) throw new Error('Typst nativo non rilevato.');
          await window.scanConverterDesktop.prepareTypstFigureSet({
            figureSetId: 'desktop-smoke',
            reset: true,
          });
          await window.scanConverterDesktop.prepareTypstFigureSet({
            figureSetId: 'desktop-smoke',
            figure: {
              path: '/figures/smoke.png',
              bytes: Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='), c => c.charCodeAt(0)),
            },
          });
          await window.scanConverterDesktop.prepareTypstFigureSet({
            figureSetId: 'desktop-smoke',
            finalize: true,
          });
          const diagnosed = await window.scanConverterDesktop.compileTypst({
            source: 'Test #variabile-inesistente()',
            diagnoseOnly: true,
            figureSetId: 'desktop-smoke',
          });
          if (diagnosed.ok || !diagnosed.diagnostics?.some(line => /:1:6:/.test(line))) {
            throw new Error('Diagnostica nativa priva di riga/colonna.');
          }
          const compiled = await window.scanConverterDesktop.compileTypst({
            source: '= Prova desktop\\n\\nBridge nativo attivo. #image("/figures/smoke.png", width: 8pt)',
            figureSetId: 'desktop-smoke',
          });
          if (!compiled.ok || !compiled.artifact?.url) throw new Error(compiled.error || 'Compilazione fallita.');
          const response = await fetch(compiled.artifact.url, { headers: { Range: 'bytes=0-7' } });
          const magic = new TextDecoder().decode(await response.arrayBuffer());
          if (response.status !== 206 || !magic.startsWith('%PDF-')) {
            throw new Error('Lettura PDF Range non valida.');
          }
          await window.scanConverterDesktop.releasePdf(compiled.artifact.id);
          return { size: compiled.artifact.size, status: response.status };
        })()`);
        console.log(`Desktop native smoke test OK (${result.size} byte, HTTP ${result.status}).`);
        app.exit(0);
      } catch (error) {
        console.error(`Desktop native smoke test FAILED: ${error?.stack || error}`);
        app.exit(1);
      }
    });
  }

  // Carica soltanto dopo aver registrato tutti i listener: il pacchetto legge
  // index.html molto più in fretta dello sviluppo e potrebbe emettere
  // did-finish-load prima che lo smoke test sia in ascolto.
  mainWindow.loadURL(`${ORIGIN}/`);
}

// Singola istanza: evita che un secondo avvio crei un'altra finestra (con una
// seconda origine/profilo che confonderebbe la persistenza).
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    serveApp();
    enableCorsBypass();
    registerDesktopIpc();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('will-quit', shutdownTypstEngine);
}
