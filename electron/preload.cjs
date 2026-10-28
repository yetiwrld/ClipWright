const { contextBridge, ipcRenderer } = require('electron');

if (process.isMainFrame) {
  contextBridge.exposeInMainWorld('clipwright', Object.freeze({
    app: Object.freeze({
      getInfo: () => ipcRenderer.invoke('app:get-info'),
    }),
  }));
}
