import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { ipcMain, type BrowserWindow } from 'electron'
import { requestPromptOptimization } from './promptOptimizationClient.js'
import { sanitizePromptOptimizationRequest, type PromptOptimizationResult } from './promptOptimizationProtocol.js'

const INSTALL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function registerPromptOptimizationIpc(
  getWindow: () => BrowserWindow | null,
  userData: string,
  rendererUrl: string,
  endpoint: string,
) {
  let active: AbortController | undefined
  let installIdPromise: Promise<string> | undefined
  const installId = () => installIdPromise ??= (async () => {
    const file = path.join(userData, 'petcast-install-id')
    await fs.mkdir(userData, { recursive: true })
    await fs.writeFile(file, randomUUID(), { flag: 'wx', mode: 0o600 })
      .catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
    const value = (await fs.readFile(file, 'utf8')).trim()
    if (!INSTALL_ID_PATTERN.test(value)) throw new Error('Invalid installation identifier')
    return value
  })().catch(error => {
    installIdPromise = undefined
    throw error
  })
  const authorized = (event: Electron.IpcMainInvokeEvent) => {
    const window = getWindow()
    if (!window || window.isDestroyed() || event.sender !== window.webContents
      || event.senderFrame !== window.webContents.mainFrame) return false
    try {
      const actual = new URL(event.senderFrame.url)
      const expected = new URL(rendererUrl)
      return actual.origin === expected.origin && actual.protocol === expected.protocol
        && actual.host === expected.host && actual.pathname === expected.pathname
    } catch {
      return false
    }
  }

  ipcMain.handle('prompt:optimize', async (event, input: unknown): Promise<PromptOptimizationResult> => {
    const sanitized = sanitizePromptOptimizationRequest(input)
    if (!authorized(event) || !sanitized) {
      return { ok: false, code: 'INVALID_REQUEST' }
    }
    if (!endpoint.trim()) return { ok: false, code: 'UPSTREAM_UNAVAILABLE' }
    if (active && !active.signal.aborted) return { ok: false, code: 'RATE_LIMITED', retryAfterSeconds: 1 }

    const controller = new AbortController()
    active = controller
    const abort = () => controller.abort()
    event.sender.once('destroyed', abort)
    event.sender.once('did-start-navigation', abort)
    try {
      return await requestPromptOptimization(sanitized, {
        endpoint,
        installId: await installId(),
        signal: controller.signal,
      })
    } catch {
      return { ok: false, code: 'UPSTREAM_UNAVAILABLE' }
    } finally {
      event.sender.removeListener('destroyed', abort)
      event.sender.removeListener('did-start-navigation', abort)
      if (active === controller) active = undefined
    }
  })
}
