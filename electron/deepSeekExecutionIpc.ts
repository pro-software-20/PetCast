import { ipcMain, type BrowserWindow } from 'electron'
import { DeepSeekExecutionManager } from './deepSeekExecutionManager.js'
import {
  sanitizeDeepSeekExecutionDispatchInput,
  sanitizeDeepSeekExecutionReferenceInput,
  type DeepSeekExecutionOutcome,
  type DeepSeekExecutionReceipt,
  type DeepSeekExecutionSnapshot,
} from './deepSeekExecutionProtocol.js'

export interface RegisterDeepSeekExecutionIpcOptions {
  getWindow: () => BrowserWindow | null
  rendererUrl: string
  storeFile: string
  apiKey?: string
  model?: string
}

const invalid = <T>(): DeepSeekExecutionOutcome<T> => ({
  ok: false,
  error: {
    code: 'INVALID_INPUT',
    retryable: false,
    message: 'DeepSeek 执行请求无效。',
  },
})

export function registerDeepSeekExecutionIpc(options: RegisterDeepSeekExecutionIpcOptions) {
  const manager = new DeepSeekExecutionManager(options.storeFile, {
    apiKey: options.apiKey,
    model: options.model,
  })
  const authorized = (event: Electron.IpcMainInvokeEvent) => {
    const window = options.getWindow()
    if (!window || window.isDestroyed() || event.sender !== window.webContents
      || event.senderFrame !== window.webContents.mainFrame) return false
    try {
      const actual = new URL(event.senderFrame.url)
      const expected = new URL(options.rendererUrl)
      return actual.origin === expected.origin && actual.protocol === expected.protocol
        && actual.host === expected.host && actual.pathname === expected.pathname
    } catch {
      return false
    }
  }

  ipcMain.handle('deepseek-execution:dispatch', async (
    event,
    value: unknown,
  ): Promise<DeepSeekExecutionOutcome<DeepSeekExecutionReceipt>> => {
    const request = sanitizeDeepSeekExecutionDispatchInput(value)
    return authorized(event) && request ? manager.dispatch(request) : invalid()
  })
  ipcMain.handle('deepseek-execution:inspect', async (
    event,
    value: unknown,
  ): Promise<DeepSeekExecutionOutcome<DeepSeekExecutionSnapshot>> => {
    const reference = sanitizeDeepSeekExecutionReferenceInput(value)
    return authorized(event) && reference ? manager.inspect(reference) : invalid()
  })
  ipcMain.handle('deepseek-execution:cancel', async (
    event,
    value: unknown,
  ): Promise<DeepSeekExecutionOutcome<DeepSeekExecutionSnapshot>> => {
    const reference = sanitizeDeepSeekExecutionReferenceInput(value)
    return authorized(event) && reference ? manager.cancel(reference) : invalid()
  })
  return manager
}
