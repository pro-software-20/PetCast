import { ipcMain, shell, type BrowserWindow } from 'electron'
import type { ChatGptAuthService } from './chatGptAuth.js'
import {
  isChatGptAuthRequestId,
  type ChatGptSessionResult,
} from './chatGptAuthProtocol.js'

const unavailable = (): ChatGptSessionResult => ({
  ok: false,
  code: 'UNAVAILABLE',
  checkedAt: new Date().toISOString(),
})

export function registerChatGptAuthIpc(options: {
  getWindow: () => BrowserWindow | null
  rendererUrl: string
  auth: ChatGptAuthService
}) {
  const authorized = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) => {
    const window = options.getWindow()
    if (!window || window.isDestroyed() || event.sender !== window.webContents
      || event.senderFrame !== window.webContents.mainFrame) return false
    try {
      const actual = new URL(event.senderFrame.url), expected = new URL(options.rendererUrl)
      return actual.origin === expected.origin && actual.protocol === expected.protocol
        && actual.host === expected.host && actual.pathname === expected.pathname
    } catch { return false }
  }

  ipcMain.handle('chatgpt-auth:read', event => (
    authorized(event) ? options.auth.readSession() : unavailable()
  ))
  ipcMain.handle('chatgpt-auth:sign-in', (event, requestId: unknown) => (
    authorized(event) && isChatGptAuthRequestId(requestId)
      ? options.auth.signIn(requestId)
      : unavailable()
  ))
  ipcMain.on('chatgpt-auth:cancel', (event, requestId: unknown) => {
    if (authorized(event) && isChatGptAuthRequestId(requestId)) options.auth.cancelSignIn(requestId)
  })
  ipcMain.handle('chatgpt-auth:sign-out', event => (
    authorized(event) ? options.auth.disconnect() : unavailable()
  ))
  ipcMain.handle('chatgpt-auth:open-usage', async event => {
    if (!authorized(event)) return false
    await shell.openExternal('https://chatgpt.com/settings/usage')
    return true
  })
}

