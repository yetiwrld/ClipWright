const { contextBridge, ipcRenderer, webUtils } = require('electron');

if (process.isMainFrame) {
  contextBridge.exposeInMainWorld('clipwright', Object.freeze({
    app: Object.freeze({
      getInfo: () => ipcRenderer.invoke('app:get-info'),
    }),
    exportFiles: Object.freeze({
      getDefaultFolder: () => ipcRenderer.invoke('export-files:get-default-folder'),
      chooseFolder: () => ipcRenderer.invoke('export-files:choose-folder'),
      begin: (payload) => ipcRenderer.invoke('export-files:begin', payload),
      write: (payload) => ipcRenderer.invoke('export-files:write', payload),
      prepare: (id) => ipcRenderer.invoke('export-files:prepare', id),
      read: (payload) => ipcRenderer.invoke('export-files:read', payload),
      commit: (id) => ipcRenderer.invoke('export-files:commit', id),
      abort: (id) => ipcRenderer.invoke('export-files:abort', id),
      openFolder: (handle) => ipcRenderer.invoke('export-files:open-folder', handle),
    }),
    projectFiles: Object.freeze({
      open: () => ipcRenderer.invoke('project-files:open'),
      saveAs: (payload) => ipcRenderer.invoke('project-files:save-as', payload),
      save: (payload) => ipcRenderer.invoke('project-files:save', payload),
      listRecoveryPoints: (handle) => ipcRenderer.invoke('project-files:list-recovery', handle),
      readRecoveryPoint: (payload) => ipcRenderer.invoke('project-files:read-recovery', payload),
    }),
    library: Object.freeze({
      initialize: () => ipcRenderer.invoke('library:initialize'),
      saveProject: (payload) => ipcRenderer.invoke('library:save-project', payload),
      importFile: (file, payload) => {
        const filePath = webUtils.getPathForFile(file);
        if (!filePath) return Promise.reject(new Error('The selected local file has no native path.'));
        return ipcRenderer.invoke('library:import-media', { ...payload, filePath });
      },
      resolveMedia: (projectId) => ipcRenderer.invoke('library:resolve-media', projectId),
      revealMedia: (payload) => ipcRenderer.invoke('library:reveal-media', payload),
      openDataFolder: () => ipcRenderer.invoke('library:open-data-folder'),
      clearCache: () => ipcRenderer.invoke('library:clear-cache'),
      cloneProject: (payload) => ipcRenderer.invoke('library:clone-project', payload),
      archiveProject: (projectId) => ipcRenderer.invoke('library:archive-project', projectId),
      createBackup: (payload) => ipcRenderer.invoke('library:create-backup', payload),
      restoreBackup: () => ipcRenderer.invoke('library:restore-backup'),
    }),
  }));
}
