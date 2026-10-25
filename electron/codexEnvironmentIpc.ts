import { ipcMain, type BrowserWindow } from 'electron'
import { checkCodexEnvironment } from './codexEnvironment.js'
import {
  MINIMUM_CODEX_VERSION,
  type CodexEnvironmentResult,
} from './codexEnvironmentProtocol.js'
import type { CodexScopeIdentity } from './codexScopeIdentity.js'
import type { ChatGptAuthService } from './chatGptAuth.js'

const unavailable = (): CodexEnvironmentResult => ({
  ok: false,
  code: 'UNAVAILABLE',
  checkedAt: new Date().toISOString(),
  minimumVersion: MINIMUM_CODEX_VERSION,
})

export function registerCodexEnvironmentIpc(options: {
  getWindow: () => BrowserWindow | null
  rendererUrl: string
  identity: CodexScopeIdentity
  auth: ChatGptAuthService
  experimentalLocalAuth: boolean
}) {
  let active: { id: string; controller: AbortController } | undefined
  const authorized = (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) => {
    const window = options.getWindow()
    if (!window || window.isDestroyed() || event.sender !== window.webContents
      || event.senderFrame !== window.webContents.mainFrame) return false
    try {
      const actual = new URL(event.senderFrame.url), expected = new URL(options.rendererUrl)
      return actual.origin === expected.origin && actual.protocol === expected.protocol
        && actual.host === expected.host && actual.pathname === expected.pathname
    } catch { return false }
  }

  ipcMain.handle('codex:check-environment', async (event, id: unknown): Promise<CodexEnvironmentResult> => {
    if (!authorized(event) || typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(id)
      || (active && !active.controller.signal.aborted)) return unavailable()
    const request = { id, controller: new AbortController() }
    active = request
    const cancel = () => request.controller.abort()
    event.sender.once('destroyed', cancel)
    event.sender.once('did-start-navigation', cancel)
    try {
      return await checkCodexEnvironment({
        identity: options.identity,
        signal: request.controller.signal,
        readOAuthSession: () => options.auth.readSession(),
        experimentalLocalAuth: options.experimentalLocalAuth,
      })
    } catch { return unavailable() }
    finally {
      event.sender.removeListener('destroyed', cancel)
      event.sender.removeListener('did-start-navigation', cancel)
      if (active === request) active = undefined
    }
  })

  ipcMain.on('codex:cancel-environment', (event, id: unknown) => {
    const request = active
    if (authorized(event) && request && request.id === id) request.controller.abort()
  })
}
