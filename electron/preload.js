const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Dialog
  openMedia: () => ipcRenderer.invoke('dialog:openMedia'),
  openSubtitle: () => ipcRenderer.invoke('dialog:openSubtitle'),
});
