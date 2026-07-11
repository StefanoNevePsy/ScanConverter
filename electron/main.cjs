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
const { app, BrowserWindow, shell, session, protocol } = require('electron');
const path = require('path');
const fs = require('fs');

// La dist buildata è impacchettata accanto a questo file (vedi "files" in
// package.json → electron-builder). In sviluppo (`electron .`) è ../dist.
const DIST = path.join(__dirname, '..', 'dist');
const SCHEME = 'app';
const ORIGIN = `${SCHEME}://scanconverter`;

let mainWindow = null;

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
};

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
      spellcheck: false,
    },
  });

  mainWindow.loadURL(`${ORIGIN}/`);

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
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
