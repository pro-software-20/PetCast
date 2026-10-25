import { app, BrowserWindow, ipcMain, safeStorage, screen, shell } from 'electron'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promises as fs, mkdtempSync } from 'node:fs'
import path from 'node:path'
import { registerCodexUsageIpc } from './codexIpc.js'
import { registerCodexEnvironmentIpc } from './codexEnvironmentIpc.js'
import { registerUsageHistoryIpc } from './historyIpc.js'
import { registerPromptOptimizationIpc } from './promptOptimizationIpc.js'
import { registerWorkspaceIpc } from './workspaceIpc.js'
import { WorkspaceRegistry } from './workspaceRegistry.js'
import { createCodexScopeIdentity } from './codexScopeIdentity.js'
import { registerTaskExecutionIpc } from './taskExecutionIpc.js'
import { ChatGptAuthService } from './chatGptAuth.js'
import { registerChatGptAuthIpc } from './chatGptAuthIpc.js'

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const COMPACT = { width: 300, height: 340 }
// 760 × 510 game scene + 218 px mock sidecar + 14 px gap + 16 px app padding.
const EXPANDED = { width: 1008, height: 526 }

let mainWindow: BrowserWindow | null = null
let compactBounds: Electron.Rectangle | null = null
let dragOffset: { x: number; y: number } | null = null
let animationToken = 0
const isSmokeTest = process.env.PETCAST_SMOKE_TEST === '1'
if (isSmokeTest) app.setPath('userData', mkdtempSync(path.join(app.getPath('temp'), 'petcast-smoke-')))

const animateBounds = async (target: Electron.Rectangle) => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const token = ++animationToken
  const start = mainWindow.getBounds()
  const duration = 260
  const startTime = performance.now()

  return new Promise<void>((resolve) => {
    const tick = () => {
      if (!mainWindow || mainWindow.isDestroyed() || token !== animationToken) return resolve()
      const progress = Math.min((performance.now() - startTime) / duration, 1)
      const eased = 1 - Math.pow(1 - progress, 3)
      const value = (from: number, to: number) => Math.round(from + (to - from) * eased)
      mainWindow.setBounds({
        x: value(start.x, target.x),
        y: value(start.y, target.y),
        width: value(start.width, target.width),
        height: value(start.height, target.height),
      })
      if (progress < 1) setTimeout(tick, 16)
      else resolve()
    }
    tick()
  })
}

const createWindow = () => {
  const { workArea } = screen.getPrimaryDisplay()
  const initial = {
    x: workArea.x + workArea.width - COMPACT.width - 28,
    y: workArea.y + workArea.height - COMPACT.height - 28,
    ...COMPACT,
  }

  mainWindow = new BrowserWindow({
    ...initial,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    hasShadow: true,
    webPreferences: {
      preload: path.join(currentDir, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  mainWindow.setAlwaysOnTop(true, 'floating')
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  mainWindow.once('ready-to-show', () => {
    if (!isSmokeTest) mainWindow?.show()
  })
  mainWindow.webContents.once('did-finish-load', () => {
    console.log('PETCAST_RENDERER_READY')
    if (isSmokeTest) {
      void mainWindow?.webContents.executeJavaScript(
        `typeof window.petcast?.readCodexUsage === 'function'
          && typeof window.petcast?.cancelCodexUsage === 'function'
          && typeof window.petcast?.checkCodexEnvironment === 'function'
          && typeof window.petcast?.cancelCodexEnvironment === 'function'
          && typeof window.petcast?.readChatGptSession === 'function'
          && typeof window.petcast?.signInWithChatGpt === 'function'
          && typeof window.petcast?.signOutChatGpt === 'function'
          && typeof window.petcast?.optimizeTaskPrompt === 'function'
          && typeof window.petcast?.selectTaskWorkspace === 'function'
          && typeof window.petcast?.prepareCodexTaskExecution === 'function'
          && typeof window.petcast?.runCodexTaskExecution === 'function'
          && typeof window.petcast?.loadGameSave === 'function'`,
      ).then(async ready => {
        if (!ready) { console.error('PETCAST_PRELOAD_FAILED'); app.exit(1); return }
        console.log('PETCAST_PRELOAD_READY')
        if (process.env.PETCAST_SMOKE_CODEX === '1') {
          const result = await mainWindow?.webContents.executeJavaScript(
            `new Promise(resolve => {
              const deadline = Date.now() + 20000;
              const check = () => {
                const node = document.querySelector('main[data-usage-source="real"]');
                if (node?.dataset.usageStatus === 'fresh' && node.dataset.historyStatus === 'saved') return resolve(true);
                if (Date.now() >= deadline) return resolve(false);
                setTimeout(check, 100);
              }; check();
            })`,
          )
          if (!result) { console.error('PETCAST_CODEX_IPC_FAILED'); app.exit(1); return }
          console.log('PETCAST_CODEX_IPC_READY')
        }
        app.quit()
      }).catch(() => { console.error('PETCAST_PRELOAD_FAILED'); app.exit(1) })
    }
  })
  mainWindow.webContents.once('did-fail-load', (_event, errorCode, errorDescription) => {
    console.error(`PETCAST_RENDERER_FAILED ${errorCode}: ${errorDescription}`)
    if (isSmokeTest) app.exit(1)
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url === 'https://x.com/thsottiaux/status/2103911959544610829') {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl) mainWindow.loadURL(devUrl)
  else mainWindow.loadFile(path.join(currentDir, '../dist/index.html'))
}

const ownsInstance = app.requestSingleInstanceLock()
if (!ownsInstance) app.quit()
app.on('second-instance', () => { mainWindow?.show(); mainWindow?.focus() })

if (ownsInstance) app.whenReady().then(() => {
  const rendererUrl = process.env.VITE_DEV_SERVER_URL
    ?? pathToFileURL(path.join(currentDir, '../dist/index.html')).href
  const workspaceRegistry = new WorkspaceRegistry()
  const codexIdentity = createCodexScopeIdentity(app.getPath('userData'))
  const chatGptAuth = new ChatGptAuthService(
    path.join(app.getPath('userData'), 'chatgpt'),
    codexIdentity,
    {
      protection: {
        isAvailable: () => safeStorage.isEncryptionAvailable(),
        encrypt: value => safeStorage.encryptString(value),
        decrypt: value => safeStorage.decryptString(value),
      },
      openExternal: async url => {
        const target = new URL(url)
        if (target.origin !== 'https://auth.openai.com') throw new Error('Unexpected sign-in destination')
        await shell.openExternal(target.href)
      },
    },
  )
  registerChatGptAuthIpc({ getWindow: () => mainWindow, rendererUrl, auth: chatGptAuth })
  registerCodexUsageIpc(() => mainWindow, app.getPath('userData'), rendererUrl, codexIdentity)
  registerCodexEnvironmentIpc({
    getWindow: () => mainWindow,
    rendererUrl,
    identity: codexIdentity,
    auth: chatGptAuth,
    experimentalLocalAuth: process.env.PETCAST_EXPERIMENTAL_LOCAL_CODEX_AUTH === '1',
  })
  registerUsageHistoryIpc(() => mainWindow, app.getPath('userData'), rendererUrl)
  registerPromptOptimizationIpc(
    () => mainWindow,
    app.getPath('userData'),
    rendererUrl,
    process.env.PETCAST_PROMPT_API_URL ?? '',
  )
  registerWorkspaceIpc(() => mainWindow, app.getPath('userData'), rendererUrl, workspaceRegistry)
  const taskExecutionManager = registerTaskExecutionIpc({
    getWindow: () => mainWindow,
    rendererUrl,
    workspaces: workspaceRegistry,
    identity: codexIdentity,
    auth: chatGptAuth,
    experimentalLocalAuth: process.env.PETCAST_EXPERIMENTAL_LOCAL_CODEX_AUTH === '1',
  })
  let taskExecutionCleanupStarted = false
  app.on('before-quit', (event) => {
    if (taskExecutionCleanupStarted) return
    taskExecutionCleanupStarted = true
    event.preventDefault()
    chatGptAuth.dispose()
    void taskExecutionManager.dispose().finally(() => app.quit())
  })
  const savePath = path.join(app.getPath('userData'), 'petcast-save.json')

  ipcMain.handle('storage:load', async () => {
    try {
      return JSON.parse(await fs.readFile(savePath, 'utf8'))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return null
      await fs.rename(savePath, `${savePath}.corrupt-${Date.now()}`).catch(() => undefined)
      return null
    }
  })

  ipcMain.handle('storage:save', async (_event, value: unknown) => {
    await fs.mkdir(path.dirname(savePath), { recursive: true })
    await fs.writeFile(savePath, JSON.stringify(value, null, 2), 'utf8')
  })

  ipcMain.on('window:drag-start', () => {
    if (!mainWindow) return
    const pointer = screen.getCursorScreenPoint()
    const bounds = mainWindow.getBounds()
    dragOffset = { x: pointer.x - bounds.x, y: pointer.y - bounds.y }
  })

  ipcMain.on('window:drag-move', () => {
    if (!mainWindow || !dragOffset) return
    const pointer = screen.getCursorScreenPoint()
    mainWindow.setPosition(pointer.x - dragOffset.x, pointer.y - dragOffset.y, false)
  })

  ipcMain.on('window:drag-end', () => {
    dragOffset = null
  })

  ipcMain.handle('window:toggle-expanded', async (_event, expanded: boolean) => {
    if (!mainWindow) return
    if (expanded) {
      compactBounds = mainWindow.getBounds()
      const display = screen.getDisplayMatching(compactBounds)
      const area = display.workArea
      const width = Math.min(EXPANDED.width, area.width - 24)
      const height = Math.min(EXPANDED.height, area.height - 24)
      const centerX = compactBounds.x + compactBounds.width / 2
      const centerY = compactBounds.y + compactBounds.height / 2
      const x = Math.max(area.x + 12, Math.min(Math.round(centerX - width / 2), area.x + area.width - width - 12))
      const y = Math.max(area.y + 12, Math.min(Math.round(centerY - height / 2), area.y + area.height - height - 12))
      await animateBounds({ x, y, width, height })
    } else if (compactBounds) {
      await animateBounds(compactBounds)
      compactBounds = null
    }
  })

  ipcMain.on('window:close', () => mainWindow?.close())
  createWindow()
})

app.on('window-all-closed', () => app.quit())
