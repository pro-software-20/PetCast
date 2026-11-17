import { app, BrowserWindow, ipcMain, safeStorage, screen, shell } from 'electron'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promises as fs, mkdtempSync } from 'node:fs'
import path from 'node:path'
import { registerCodexUsageIpc } from './codexIpc.js'
import { registerCodexEnvironmentIpc } from './codexEnvironmentIpc.js'
import { registerUsageHistoryIpc } from './historyIpc.js'
import { registerPromptOptimizationIpc } from './promptOptimizationIpc.js'
import { registerTaskPlanningIpc } from './taskPlanningIpc.js'
import { registerWorkspaceIpc } from './workspaceIpc.js'
import { WorkspaceRegistry } from './workspaceRegistry.js'
import { createCodexScopeIdentity } from './codexScopeIdentity.js'
import { registerTaskExecutionIpc } from './taskExecutionIpc.js'
import { ChatGptAuthService } from './chatGptAuth.js'
import { registerChatGptAuthIpc } from './chatGptAuthIpc.js'
import { resolveAiServiceUrl } from './aiServiceConfig.js'
import { registerCustomPetIpc } from './customPetIpc.js'
import { registerDeepSeekExecutionIpc } from './deepSeekExecutionIpc.js'

const currentDir = path.dirname(fileURLToPath(import.meta.url))
app.setAppUserModelId('io.github.pro-software-20.petcast')
// Keep the existing data directory when the packaged product name becomes PetCast.
app.setPath('userData', path.join(app.getPath('appData'), 'petcast-stage1'))
const COMPACT = { width: 300, height: 340 }
// Expanded content fills the user-resizable window.
const EXPANDED = { width: 900, height: 650 }
const MIN_EXPANDED = { width: 640, height: 440 }
type WindowResizeCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

let mainWindow: BrowserWindow | null = null
let compactBounds: Electron.Rectangle | null = null
let dragState: {
  offsetX: number
  offsetY: number
  width: number
  height: number
} | null = null
let expandedSize = { ...EXPANDED }
let windowExpanded = false
let resizeState: { corner: WindowResizeCorner; bounds: Electron.Rectangle; pointer: Electron.Point; area: Electron.Rectangle } | null = null
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
    alwaysOnTop: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    hasShadow: true,
    icon: path.join(currentDir, '../dist/assets/app/icon.png'),
    webPreferences: {
      preload: path.join(currentDir, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  mainWindow.setAlwaysOnTop(false)
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
          && typeof window.petcast?.planTaskWithDeepSeek === 'function'
          && typeof window.petcast?.cancelDeepSeekTaskPlan === 'function'
          && typeof window.petcast?.dispatchDeepSeekExecution === 'function'
          && typeof window.petcast?.inspectDeepSeekExecution === 'function'
          && typeof window.petcast?.cancelDeepSeekExecution === 'function'
          && typeof window.petcast?.selectTaskWorkspace === 'function'
          && typeof window.petcast?.prepareCodexTaskExecution === 'function'
          && typeof window.petcast?.runCodexTaskExecution === 'function'
          && typeof window.petcast?.readCustomPet === 'function'
          && typeof window.petcast?.saveCustomPet === 'function'
          && typeof window.petcast?.deleteCustomPet === 'function'
          && typeof window.petcast?.beginResize === 'function'
          && typeof window.petcast?.resizeWindow === 'function'
          && typeof window.petcast?.endResize === 'function'
          && typeof window.petcast?.loadGameSave === 'function'`,
      ).then(async ready => {
        if (!ready) { console.error('PETCAST_PRELOAD_FAILED'); app.exit(1); return }
        console.log('PETCAST_PRELOAD_READY')
        const customPetReady = await mainWindow?.webContents.executeJavaScript(
          `(async () => {
            const canvas = document.createElement('canvas'); canvas.width = 16; canvas.height = 16;
            const context = canvas.getContext('2d'); if (!context) return false;
            context.fillStyle = '#e8a7bd'; context.fillRect(0, 0, 16, 16);
            const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
            if (!blob) return false;
            const saved = await window.petcast.saveCustomPet(new Uint8Array(await blob.arrayBuffer()));
            const read = await window.petcast.readCustomPet();
            const removed = await window.petcast.deleteCustomPet();
            return saved.ok && saved.asset?.width === 16 && saved.asset?.height === 16
              && read.ok && read.asset?.revision === saved.asset.revision
              && removed.ok && removed.asset === null;
          })()`,
        )
        if (!customPetReady) { console.error('PETCAST_CUSTOM_PET_IPC_FAILED'); app.exit(1); return }
        console.log('PETCAST_CUSTOM_PET_IPC_READY')
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

if (ownsInstance) app.whenReady().then(async () => {
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
  registerCustomPetIpc(() => mainWindow, app.getPath('userData'), rendererUrl)
  const aiApiUrl = await resolveAiServiceUrl({
    configPath: path.join(currentDir, 'ai-service-config.json'),
    runtimeUrl: process.env.PETCAST_AI_API_URL,
    legacyRuntimeUrl: process.env.PETCAST_PROMPT_API_URL,
    allowRuntimeOverride: !app.isPackaged,
  })
  registerPromptOptimizationIpc(
    () => mainWindow,
    app.getPath('userData'),
    rendererUrl,
    aiApiUrl,
  )
  registerTaskPlanningIpc(
    () => mainWindow,
    app.getPath('userData'),
    rendererUrl,
    aiApiUrl,
  )
  const deepSeekExecutionManager = registerDeepSeekExecutionIpc({
    getWindow: () => mainWindow,
    rendererUrl,
    storeFile: path.join(app.getPath('userData'), 'deepseek-executions.v1.json'),
    apiKey: process.env.DEEPSEEK_API_KEY,
    model: process.env.DEEPSEEK_MODEL,
  })
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
    void Promise.all([
      taskExecutionManager.dispose(),
      deepSeekExecutionManager.dispose(),
    ]).finally(() => app.quit())
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
    dragState = {
      offsetX: pointer.x - bounds.x,
      offsetY: pointer.y - bounds.y,
      width: bounds.width,
      height: bounds.height,
    }
  })

  ipcMain.on('window:drag-move', () => {
    if (!mainWindow || !dragState) return
    const pointer = screen.getCursorScreenPoint()
    mainWindow.setBounds({
      x: pointer.x - dragState.offsetX,
      y: pointer.y - dragState.offsetY,
      width: dragState.width,
      height: dragState.height,
    }, false)
  })

  ipcMain.on('window:drag-end', () => {
    dragState = null
  })

  const trustedWindowEvent = (event: Electron.IpcMainEvent) => Boolean(mainWindow && !mainWindow.isDestroyed()
    && event.sender === mainWindow.webContents && event.senderFrame === mainWindow.webContents.mainFrame)
  const resizeCorners: readonly WindowResizeCorner[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right']

  ipcMain.on('window:resize-start', (event, corner: unknown) => {
    if (!trustedWindowEvent(event) || !mainWindow || !windowExpanded
      || typeof corner !== 'string' || !resizeCorners.includes(corner as WindowResizeCorner)) return
    const bounds = mainWindow.getBounds()
    resizeState = {
      corner: corner as WindowResizeCorner,
      bounds,
      pointer: screen.getCursorScreenPoint(),
      area: screen.getDisplayMatching(bounds).workArea,
    }
    dragState = null
  })

  ipcMain.on('window:resize-move', event => {
    if (!trustedWindowEvent(event) || !mainWindow || !resizeState || !windowExpanded) return
    const pointer = screen.getCursorScreenPoint()
    const { corner, bounds, area } = resizeState
    const dx = pointer.x - resizeState.pointer.x
    const dy = pointer.y - resizeState.pointer.y
    const fromLeft = corner.endsWith('left')
    const fromTop = corner.startsWith('top')
    const horizontalLimit = fromLeft
      ? bounds.x + bounds.width - (area.x + 12)
      : area.x + area.width - 12 - bounds.x
    const verticalLimit = fromTop
      ? bounds.y + bounds.height - (area.y + 12)
      : area.y + area.height - 12 - bounds.y
    const minWidth = Math.min(MIN_EXPANDED.width, horizontalLimit)
    const minHeight = Math.min(MIN_EXPANDED.height, verticalLimit)
    const proposedWidth = fromLeft ? bounds.width - dx : bounds.width + dx
    const proposedHeight = fromTop ? bounds.height - dy : bounds.height + dy
    const width = Math.max(minWidth, Math.min(horizontalLimit, proposedWidth))
    const height = Math.max(minHeight, Math.min(verticalLimit, proposedHeight))
    mainWindow.setBounds({
      x: fromLeft ? bounds.x + bounds.width - width : bounds.x,
      y: fromTop ? bounds.y + bounds.height - height : bounds.y,
      width,
      height,
    }, false)
  })

  ipcMain.on('window:resize-end', event => {
    if (!trustedWindowEvent(event)) return
    if (mainWindow && resizeState && windowExpanded) {
      const bounds = mainWindow.getBounds()
      expandedSize = { width: bounds.width, height: bounds.height }
    }
    resizeState = null
  })

  ipcMain.handle('window:toggle-expanded', async (_event, expanded: boolean) => {
    if (!mainWindow) return
    resizeState = null
    windowExpanded = expanded
    if (expanded) {
      // Four explicit renderer handles own resizing. Native resizing on a
      // transparent frameless window can change its size during interior drag.
      mainWindow.setResizable(false)
      compactBounds = mainWindow.getBounds()
      const display = screen.getDisplayMatching(compactBounds)
      const area = display.workArea
      const width = Math.min(expandedSize.width, area.width - 24)
      const height = Math.min(expandedSize.height, area.height - 24)
      const centerX = compactBounds.x + compactBounds.width / 2
      const centerY = compactBounds.y + compactBounds.height / 2
      const x = Math.max(area.x + 12, Math.min(Math.round(centerX - width / 2), area.x + area.width - width - 12))
      const y = Math.max(area.y + 12, Math.min(Math.round(centerY - height / 2), area.y + area.height - height - 12))
      await animateBounds({ x, y, width, height })
      mainWindow?.setMinimumSize(Math.min(640, width), Math.min(440, height))
    } else if (compactBounds) {
      const bounds = mainWindow.getBounds()
      expandedSize = { width: bounds.width, height: bounds.height }
      mainWindow.setMinimumSize(COMPACT.width, COMPACT.height)
      mainWindow.setResizable(false)
      await animateBounds(compactBounds)
      compactBounds = null
    }
  })

  ipcMain.on('window:close', () => mainWindow?.close())
  createWindow()
})

app.on('window-all-closed', () => app.quit())
