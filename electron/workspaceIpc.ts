import { createHmac, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { dialog, ipcMain, type BrowserWindow } from 'electron'
import { isWorkspaceRequestId, type WorkspaceSelectionResult } from './workspaceProtocol.js'
import { scanWorkspace } from './workspaceScanner.js'

const authorizedRenderer = (
  event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent,
  getWindow: () => BrowserWindow | null,
  rendererUrl: string,
) => {
  const window = getWindow()
  if (!window || window.isDestroyed() || event.sender !== window.webContents
    || event.senderFrame !== window.webContents.mainFrame) return false
  try {
    const actual = new URL(event.senderFrame.url)
    const expected = new URL(rendererUrl)
    return actual.origin === expected.origin
      && actual.protocol === expected.protocol
      && actual.host === expected.host
      && actual.pathname === expected.pathname
  } catch {
    return false
  }
}

export function registerWorkspaceIpc(
  getWindow: () => BrowserWindow | null,
  userData: string,
  rendererUrl: string,
) {
  const active = new Map<string, AbortController>()
  let secretPromise: Promise<Buffer> | undefined
  const installationSecret = () => secretPromise ??= (async () => {
    const secretPath = path.join(userData, 'workspace-scope.key')
    await fs.mkdir(userData, { recursive: true })
    await fs.writeFile(secretPath, randomBytes(32), { flag: 'wx', mode: 0o600 })
      .catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
    const secret = await fs.readFile(secretPath)
    if (secret.length !== 32) throw new Error('Invalid workspace secret')
    return secret
  })().catch(error => {
    secretPromise = undefined
    throw error
  })

  ipcMain.handle('workspace:select', async (event, requestId: unknown): Promise<WorkspaceSelectionResult> => {
    if (!authorizedRenderer(event, getWindow, rendererUrl) || !isWorkspaceRequestId(requestId)) {
      return { ok: false, code: 'INVALID_REQUEST', message: '工作区请求无效。' }
    }
    if (active.has(requestId)) return { ok: false, code: 'INVALID_REQUEST', message: '工作区请求正在进行。' }
    const window = getWindow()
    if (!window) return { ok: false, code: 'UNAVAILABLE', message: '桌面窗口不可用。' }

    const controller = new AbortController()
    active.set(requestId, controller)
    const abort = () => controller.abort()
    event.sender.once('destroyed', abort)
    event.sender.once('did-start-navigation', abort)
    try {
      const selection = await dialog.showOpenDialog(window, {
        title: '选择 PetCast 任务工作区',
        properties: ['openDirectory'],
      })
      if (selection.canceled || selection.filePaths.length !== 1 || controller.signal.aborted) {
        return { ok: false, code: 'CANCELLED', message: '已取消工作区选择。' }
      }
      const root = await fs.realpath(selection.filePaths[0])
      const normalizedRoot = process.platform === 'win32' ? root.toLowerCase() : root
      const workspaceId = createHmac('sha256', await installationSecret()).update(normalizedRoot).digest('hex')
      const scan = await scanWorkspace(root, { signal: controller.signal })
      if (controller.signal.aborted) return { ok: false, code: 'CANCELLED', message: '已取消工作区扫描。' }
      return {
        ok: true,
        workspace: {
          schemaVersion: 1,
          workspaceId,
          displayName: path.basename(root) || '工作区',
          ...scan,
        },
      }
    } catch (error) {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
        return { ok: false, code: 'CANCELLED', message: '已取消工作区扫描。' }
      }
      return { ok: false, code: 'SCAN_FAILED', message: '无法扫描所选工作区，请检查目录权限。' }
    } finally {
      event.sender.removeListener('destroyed', abort)
      event.sender.removeListener('did-start-navigation', abort)
      active.delete(requestId)
    }
  })

  ipcMain.on('workspace:cancel', (event, requestId: unknown) => {
    if (!authorizedRenderer(event, getWindow, rendererUrl) || !isWorkspaceRequestId(requestId)) return
    active.get(requestId)?.abort()
  })
}
