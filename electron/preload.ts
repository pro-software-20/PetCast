import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('petcast', {
  readCodexUsage: (requestId: string) => ipcRenderer.invoke('codex:read-usage', requestId),
  cancelCodexUsage: (requestId: string) => ipcRenderer.send('codex:cancel-usage', requestId),
  checkCodexEnvironment: (requestId: string) => ipcRenderer.invoke('codex:check-environment', requestId),
  cancelCodexEnvironment: (requestId: string) => ipcRenderer.send('codex:cancel-environment', requestId),
  optimizeTaskPrompt: (input: import('./promptOptimizationProtocol.js').PromptOptimizationRequest) => (
    ipcRenderer.invoke('prompt:optimize', input)
  ),
  selectTaskWorkspace: (requestId: string) => ipcRenderer.invoke('workspace:select', requestId),
  cancelTaskWorkspace: (requestId: string) => ipcRenderer.send('workspace:cancel', requestId),
  prepareCodexTaskExecution: (input: import('./taskExecutionProtocol.js').PrepareCodexTaskExecutionRequest) => (
    ipcRenderer.invoke('task-execution:prepare', input)
  ),
  runCodexTaskExecution: (executionId: string) => ipcRenderer.invoke('task-execution:run', executionId),
  cancelCodexTaskExecution: (executionId: string) => ipcRenderer.send('task-execution:cancel', executionId),
  readTaskExecutionArtifact: (artifactId: string) => ipcRenderer.invoke('task-execution:artifact-read', artifactId),
  applyTaskExecutionArtifact: (artifactId: string) => ipcRenderer.invoke('task-execution:artifact-apply', artifactId),
  discardTaskExecutionArtifact: (artifactId: string) => ipcRenderer.invoke('task-execution:artifact-discard', artifactId),
  onTaskExecutionEvent: (listener: (event: import('./taskExecutionProtocol.js').TaskExecutionEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: import('./taskExecutionProtocol.js').TaskExecutionEvent) => listener(value)
    ipcRenderer.on('task-execution:event', handler)
    return () => ipcRenderer.removeListener('task-execution:event', handler)
  },
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
