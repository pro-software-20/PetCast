import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('petcast', {
  beginDrag: () => ipcRenderer.send('window:drag-start'),
  moveDrag: () => ipcRenderer.send('window:drag-move'),
  endDrag: () => ipcRenderer.send('window:drag-end'),
  toggleExpanded: (expanded: boolean) => ipcRenderer.invoke('window:toggle-expanded', expanded),
  loadGameSave: () => ipcRenderer.invoke('storage:load'),
  saveGame: (value: unknown) => ipcRenderer.invoke('storage:save', value),
  close: () => ipcRenderer.send('window:close'),
})
