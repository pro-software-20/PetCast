import { ipcMain, type BrowserWindow } from 'electron'
import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { readCodexQuota } from './codexUsage.js'
import type { CodexQuotaResult } from './codexProtocol.js'
import type { CodexScopeIdentity } from './codexScopeIdentity.js'

/** Registration kept separate so C can reuse it without moving quota logic into main.ts. */
export function registerCodexUsageIpc(
  getWindow: () => BrowserWindow | null,
  userData: string,
  rendererUrl: string,
  identity?: CodexScopeIdentity,
) {
  let active: { id: string; controller: AbortController } | undefined
  let saltPromise: Promise<string> | undefined
  const fallbackSalt = () => saltPromise ??= (async () => {
    const file = path.join(userData, 'codex-scope-salt')
    await fs.mkdir(userData, { recursive: true })
    await fs.writeFile(file, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 })
      .catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
    const value = (await fs.readFile(file, 'utf8')).trim()
    if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid scope salt')
    return value
  })().catch(error => { saltPromise = undefined; throw error })
  const authorized = (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) => {
    const window = getWindow()
    if (!window || window.isDestroyed() || event.sender !== window.webContents
      || event.senderFrame !== window.webContents.mainFrame) return false
    try {
      const actual = new URL(event.senderFrame.url), expected = new URL(rendererUrl)
      return actual.origin === expected.origin && actual.protocol === expected.protocol
        && actual.host === expected.host && actual.pathname === expected.pathname
    } catch { return false }
  }
  ipcMain.handle('codex:read-usage', async (event, id: unknown): Promise<CodexQuotaResult> => {
    if (!authorized(event) || typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(id)
      || (active && !active.controller.signal.aborted)) {
      return { ok: false, code: 'UNAVAILABLE' }
    }
    const request = { id, controller: new AbortController() }
    active = request
    const cancel = () => request.controller.abort()
    event.sender.once('destroyed', cancel)
    event.sender.once('did-start-navigation', cancel)
    try {
      return await readCodexQuota({ scopeSalt: await (identity?.getSalt() ?? fallbackSalt()), signal: request.controller.signal })
    } catch { return { ok: false, code: 'UNAVAILABLE' } }
    finally {
      event.sender.removeListener('destroyed', cancel)
      event.sender.removeListener('did-start-navigation', cancel)
      if (active === request) active = undefined
    }
  })
  ipcMain.on('codex:cancel-usage', (event, id: unknown) => {
    if (authorized(event) && active && active.id === id) active.controller.abort()
  })
}
