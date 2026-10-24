import { ipcMain, type BrowserWindow } from 'electron'
import type { CodexScopeIdentity } from './codexScopeIdentity.js'
import { TaskExecutionManager } from './taskExecutionManager.js'
import {
  isTaskExecutionId,
  TASK_EXECUTION_MESSAGES,
  validatePrepareCodexTaskExecutionRequest,
  type TaskExecutionOutcome,
} from './taskExecutionProtocol.js'
import type { WorkspaceRegistry } from './workspaceRegistry.js'

const denied = (): TaskExecutionOutcome<never> => ({
  ok: false,
  code: 'INVALID_REQUEST',
  message: TASK_EXECUTION_MESSAGES.INVALID_REQUEST,
})

export function registerTaskExecutionIpc(options: {
  getWindow: () => BrowserWindow | null
  rendererUrl: string
  workspaces: WorkspaceRegistry
  identity: CodexScopeIdentity
}) {
  const authorized = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) => {
    const window = options.getWindow()
    if (!window || window.isDestroyed() || event.sender !== window.webContents
      || event.senderFrame !== window.webContents.mainFrame) return false
    try {
      const actual = new URL(event.senderFrame.url)
      const expected = new URL(options.rendererUrl)
      return actual.origin === expected.origin && actual.protocol === expected.protocol
        && actual.host === expected.host && actual.pathname === expected.pathname
    } catch { return false }
  }
  const manager = new TaskExecutionManager(options.workspaces, options.identity, event => {
    const window = options.getWindow()
    if (window && !window.isDestroyed()) window.webContents.send('task-execution:event', event)
  })

  ipcMain.handle('task-execution:prepare', async (event, input: unknown) => {
    if (!authorized(event)) return denied()
    try { return await manager.prepare(validatePrepareCodexTaskExecutionRequest(input)) }
    catch (error) {
      const code = error instanceof Error && error.message === 'PATH_NOT_ALLOWED' ? 'PATH_NOT_ALLOWED' : 'INVALID_REQUEST'
      return { ok: false, code, message: TASK_EXECUTION_MESSAGES[code] }
    }
  })
  ipcMain.handle('task-execution:run', (event, id: unknown) => (
    authorized(event) && isTaskExecutionId(id) ? manager.run(id) : denied()
  ))
  ipcMain.on('task-execution:cancel', (event, id: unknown) => {
    if (authorized(event) && isTaskExecutionId(id)) void manager.cancel(id)
  })
  ipcMain.handle('task-execution:artifact-read', (event, id: unknown) => (
    authorized(event) && isTaskExecutionId(id) ? manager.readArtifact(id) : denied()
  ))
  ipcMain.handle('task-execution:artifact-apply', (event, id: unknown) => (
    authorized(event) && isTaskExecutionId(id) ? manager.applyArtifact(id) : denied()
  ))
  ipcMain.handle('task-execution:artifact-discard', (event, id: unknown) => (
    authorized(event) && isTaskExecutionId(id) ? manager.discardArtifact(id) : denied()
  ))
  return manager
}
