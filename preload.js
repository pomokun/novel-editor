const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openFile: () => ipcRenderer.invoke('dialog:open'),
  saveFile: (payload) => ipcRenderer.invoke('dialog:save', payload),
  saveFileAs: (payload) => ipcRenderer.invoke('dialog:save-as', payload),
  confirmDiscard: () => ipcRenderer.invoke('dialog:confirm-discard'),
  driveList: () => ipcRenderer.invoke('drive:list'),
  driveOpen: (id) => ipcRenderer.invoke('drive:open', id),
  driveSave: (payload) => ipcRenderer.invoke('drive:save', payload),
  driveCheck: (payload) => ipcRenderer.invoke('drive:check', payload),
  driveConfirmReload: (payload) => ipcRenderer.invoke('drive:confirm-reload', payload),
  onMenu: (channel, handler) => ipcRenderer.on(channel, handler),
});
