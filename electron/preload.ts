import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('petcast', {
  readCodexUsage: (requestId: string) => ipcRenderer.invoke('codex:read-usage', requestId),
  cancelCodexUsage: (requestId: string) => ipcRenderer.send('codex:cancel-usage', requestId),
  optimizeTaskPrompt: (input: import('./promptOptimizationProtocol.js').PromptOptimizationRequest) => (
    ipcRenderer.invoke('prompt:optimize', input)
  ),
  writeExecutionEvent: (event: unknown) => ipcRenderer.invoke('tasks:execution-write', event),
  queryExecutions: (scope: unknown) => ipcRenderer.invoke('tasks:executions', scope),
  reconcileExecutions: (scope: unknown) => ipcRenderer.invoke('tasks:reconcile', scope),
  appendTaskEvaluations: (events: unknown) => ipcRenderer.invoke('tasks:evaluate', events),
  queryTaskEvaluations: (query: unknown) => ipcRenderer.invoke('tasks:evaluations', query),
  appendTaskRecords: (tasks: unknown) => ipcRenderer.invoke('tasks:append', tasks),
  queryTaskRecords: (query: unknown) => ipcRenderer.invoke('tasks:query', query),
  clearTaskRecords: (scope: unknown) => ipcRenderer.invoke('tasks:clear', scope),
  appendUsageSample: (sample: unknown) => ipcRenderer.invoke('history:append', sample),
  queryUsageSamples: (query: unknown) => ipcRenderer.invoke('history:query', query),
  clearUsageHistory: (scope: unknown) => ipcRenderer.invoke('history:clear', scope),
  beginDrag: () => ipcRenderer.send('window:drag-start'),
  moveDrag: () => ipcRenderer.send('window:drag-move'),
  endDrag: () => ipcRenderer.send('window:drag-end'),
  toggleExpanded: (expanded: boolean) => ipcRenderer.invoke('window:toggle-expanded', expanded),
  loadGameSave: () => ipcRenderer.invoke('storage:load'),
  saveGame: (value: unknown) => ipcRenderer.invoke('storage:save', value),
  close: () => ipcRenderer.send('window:close'),
})
