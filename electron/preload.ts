import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('petcast', {
  readCodexUsage: (requestId: string) => ipcRenderer.invoke('codex:read-usage', requestId),
  cancelCodexUsage: (requestId: string) => ipcRenderer.send('codex:cancel-usage', requestId),
  optimizeTaskPrompt: (input: import('./promptOptimizationProtocol.js').PromptOptimizationRequest) => (
    ipcRenderer.invoke('prompt:optimize', input)
  ),
  beginDrag: () => ipcRenderer.send('window:drag-start'),
  moveDrag: () => ipcRenderer.send('window:drag-move'),
  endDrag: () => ipcRenderer.send('window:drag-end'),
  toggleExpanded: (expanded: boolean) => ipcRenderer.invoke('window:toggle-expanded', expanded),
  loadGameSave: () => ipcRenderer.invoke('storage:load'),
  saveGame: (value: unknown) => ipcRenderer.invoke('storage:save', value),
  close: () => ipcRenderer.send('window:close'),
})
