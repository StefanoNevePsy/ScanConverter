const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('scanConverterDesktop', Object.freeze({
  isDesktop: true,
  capabilities: () => ipcRenderer.invoke('desktop:capabilities'),
  prepareTypstFigureSet: (request) => ipcRenderer.invoke('desktop:typst:prepare-figures', request),
  compileTypst: (request) => ipcRenderer.invoke('desktop:typst:compile', request),
  savePdf: (request) => ipcRenderer.invoke('desktop:pdf:save', request),
  releasePdf: (id) => ipcRenderer.invoke('desktop:pdf:release', { id }),
}));
