// Preload of the "API keys" window: the only things the page can do. It can save or clear a key and ask which are saved;
// it can never read a saved key back.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('keys', {
  status: () => ipcRenderer.invoke('keys:status'),
  save: (name, value) => ipcRenderer.invoke('keys:save', name, value),
  clear: (name) => ipcRenderer.invoke('keys:clear', name),
});
