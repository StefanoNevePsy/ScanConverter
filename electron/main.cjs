/*
  Processo principale di ScanConverter Desktop (Electron).

  Perché esiste: su Mac/Windows come su Android il nodo è il CORS. NVIDIA NIM
  non invia gli header CORS, quindi da un browser statico le chiamate sono
  bloccate. Qui — come fa `CapacitorHttp` sul nativo Android — le richieste
  passano fuori dal controllo CORS del browser: intercettiamo le risposte
  remote e iniettiamo gli header CORS mancanti (incluso il preflight). Così
  l'OCR NVIDIA, l'elenco modelli e i motori NVIDIA/GLM/DeepSeek funzionano
  come Gemini. Verificato: senza iniezione la fetch fallisce (CORS), con
  iniezione risponde 200.

  L'app resta identica al web: viene servita da un piccolo server locale su
  127.0.0.1 e caricata nel webview. Nessuna modifica al codice dell'app.
*/
const { app, BrowserWindow, shell, session } = require('electron');
const path = require('path');
const { startServer } = require('./server.cjs');

// La dist buildata è impacchettata accanto a questo file (vedi "files" in
// package.json → electron-builder). In sviluppo (`electron .`) è ../dist.
const DIST = path.join(__dirname, '..', 'dist');

let server = null;
let mainWindow = null;

/**
 * Aggiunge gli header CORS alle risposte remote (https), incluso il preflight
 * OPTIONS che NVIDIA lascia senza header. Non tocca il server locale dell'app.
 */
function enableCorsBypass() {
  session.defaultSession.webRequest.onHeadersReceived({ urls: ['https://*/*'] }, (details, cb) => {
    const headers = details.responseHeaders || {};
    // Rimuove eventuali varianti già presenti per evitare duplicati/conflitti.
    for (const k of Object.keys(headers)) {
      if (/^access-control-allow-(origin|methods|headers)$/i.test(k)) delete headers[k];
    }
    headers['Access-Control-Allow-Origin'] = ['*'];
    headers['Access-Control-Allow-Methods'] = ['GET,POST,PUT,DELETE,PATCH,OPTIONS'];
    headers['Access-Control-Allow-Headers'] = ['authorization,content-type,x-goog-api-key,accept'];
    cb({ responseHeaders: headers });
  });
}

async function createWindow() {
  server = await startServer(DIST);

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

  mainWindow.loadURL(server.url);

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

app.whenReady().then(() => {
  enableCorsBypass();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  server?.close();
  if (process.platform !== 'darwin') app.quit();
});
