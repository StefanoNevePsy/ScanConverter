const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('scanConverterDesktop', Object.freeze({
  isDesktop: true,
  capabilities: () => ipcRenderer.invoke('desktop:capabilities'),
  localSetup: () => ipcRenderer.invoke('desktop:local-setup'),
  chooseFolder: () => ipcRenderer.invoke('desktop:choose-folder'),
  paddleInstall: (request) => ipcRenderer.invoke('desktop:paddle:install', request),
  paddleStart: (request) => ipcRenderer.invoke('desktop:paddle:start', request),
  paddleEnsure: () => ipcRenderer.invoke('desktop:paddle:ensure'),
  appleRespond: (request) => ipcRenderer.invoke('desktop:apple:respond', request),
  ollamaInstall: (request) => ipcRenderer.invoke('desktop:ollama:install', request),
  setupRun: (request) => ipcRenderer.invoke('desktop:setup:run', request),
  onPaddleLog: (callback) => {
    const listener = (_event, line) => callback(String(line));
    ipcRenderer.on('desktop:paddle:log', listener);
    return () => ipcRenderer.removeListener('desktop:paddle:log', listener);
  },
  prepareTypstFigureSet: (request) => ipcRenderer.invoke('desktop:typst:prepare-figures', request),
  compileTypst: (request) => ipcRenderer.invoke('desktop:typst:compile', request),
  savePdf: (request) => ipcRenderer.invoke('desktop:pdf:save', request),
  releasePdf: (id) => ipcRenderer.invoke('desktop:pdf:release', { id }),
}));
