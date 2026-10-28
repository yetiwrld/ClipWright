const { contextBridge, ipcRenderer } = require('electron');

if (process.isMainFrame) {
  contextBridge.exposeInMainWorld('clipwright', Object.freeze({
    app: Object.freeze({
      getInfo: () => ipcRenderer.invoke('app:get-info'),
    }),
    projectFiles: Object.freeze({
      open: () => ipcRenderer.invoke('project-files:open'),
      saveAs: (payload) => ipcRenderer.invoke('project-files:save-as', payload),
      save: (payload) => ipcRenderer.invoke('project-files:save', payload),
      listRecoveryPoints: (handle) => ipcRenderer.invoke('project-files:list-recovery', handle),
      readRecoveryPoint: (payload) => ipcRenderer.invoke('project-files:read-recovery', payload),
    }),
  }));
}
