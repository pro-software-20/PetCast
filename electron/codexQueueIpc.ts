import { ipcMain, type BrowserWindow } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { CodexAppServerSession, codexFailureMessage } from './codexAppServer.js'
import { sanitizeRemoteTaskPlan, sanitizeTaskPlanningIpcRequest, type TaskPlanningServiceResult } from './taskPlanningProtocol.js'
import { TASK_PLANNING_QUALITY_INSTRUCTIONS } from './personalPlanningInstructions.js'
import { readCodexQuota } from './codexUsage.js'
import type { CodexScopeIdentity } from './codexScopeIdentity.js'
import { DeepSeekExecutionManager } from './deepSeekExecutionManager.js'
import { sanitizeDeepSeekExecutionDispatchInput, sanitizeDeepSeekExecutionReferenceInput } from './deepSeekExecutionProtocol.js'

/** Shared durable transport; the runner uses local Codex, never the DeepSeek API. */
export function registerCodexQueueIpc(options: { getWindow: () => BrowserWindow | null; rendererUrl: string; userData: string; identity: CodexScopeIdentity }) {
  let scope: string | undefined
  let connecting = false
  const sessions = new Set<CodexAppServerSession>()
  const planning = new Map<string, AbortController>()
  const activity = new Map<string, { id: string; kind: 'planning' | 'execution' | 'connection'; taskId?: string; message: string; updatedAt: string; active: boolean }>()
  const progress = (id: string, kind: 'planning' | 'execution' | 'connection', message: string, active = true, taskId?: string) => {
    activity.set(id, { id, kind, message, active, updatedAt: new Date().toISOString(), ...(taskId ? { taskId } : {}) })
    if (activity.size > 100) activity.delete(activity.keys().next().value!)
  }
  const runText = async (id: string, kind: 'planning' | 'execution' | 'connection', prompt: string | null, signal: AbortSignal, taskId?: string) => {
    if (!scope || signal.aborted) throw Error('UNAVAILABLE')
    const expectedScope = scope
    const root = path.join(options.userData, 'codex-queue-work')
    await fs.mkdir(root, { recursive: true })
    const cwd = await fs.mkdtemp(path.join(root, 'task-'))
    progress(id, kind, '正在启动本机 Codex…', true, taskId)
    const session = new CodexAppServerSession(cwd, options.identity, message => progress(id, kind, message, true, taskId))
    sessions.add(session)
    const abort = () => { void session.interrupt() }
    signal.addEventListener('abort', abort, { once: true })
    try {
      if (signal.aborted) throw Error('CANCELLED')
      await session.prepare(expectedScope, { mode: 'local-codex-experimental', transport: 'http' })
      if (signal.aborted) throw Error('CANCELLED')
      const result = prompt === null ? { outputText: '', usage: null } : await session.run(prompt, kind === 'planning' ? 120_000 : 300_000)
      progress(id, kind, prompt === null ? '登录和执行通道已核对；点击开始分析才会调用模型。' : 'Codex 已返回结果。', false, taskId)
      return result
    } catch (error) {
      const previous = activity.get(id)?.message
      progress(id, kind, signal.aborted ? '已停止 Codex 请求。'
        : previous?.includes('Codex 上游') || previous?.includes('中断') || previous?.includes('额度不足') || previous?.includes('登录已失效')
          ? previous : codexFailureMessage(error), false, taskId)
      throw error
    } finally {
      signal.removeEventListener('abort', abort)
      session.close()
      sessions.delete(session)
      const resolved = path.resolve(cwd)
      if (resolved.startsWith(path.resolve(root) + path.sep)) await fs.rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 }).catch(() => {})
    }
  }
  const manager = new DeepSeekExecutionManager(path.join(options.userData, 'codex-queue.v1.json'), {
    timeoutMs: 10 * 60_000,
    taskRunner: async (request, signal) => {
        const result = await runText(request.dispatchId, 'execution', `只交付文本，不读取用户项目或修改用户文件，不安装软件，不访问网络。\n任务：${request.title}\n${request.description}\n${request.prompt}\n前置任务摘要：\n${request.dependencySummaries.join('\n')}\n验收要求：\n${request.acceptanceChecks.join('\n')}`, signal, request.taskId)
        return { outputText: result.outputText, ...(result.usage ? { usage: result.usage } : {}) }
    },
  })
  const authorized = (event: Electron.IpcMainInvokeEvent) => {
    const window = options.getWindow()
    return Boolean(window && !window.isDestroyed() && event.sender === window.webContents
      && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === options.rendererUrl)
  }
  const unavailable = () => ({ ok: false, error: { code: 'UNAVAILABLE', retryable: false, message: '请先连接本机 Codex；账户变化后需要重新连接。' } })
  ipcMain.handle('codex-queue:connect', async event => {
    if (!authorized(event)) return { configured: false, message: '连接请求无效。' }
    if (connecting || sessions.size || planning.size) return { configured: Boolean(scope), message: 'Codex 正在处理请求，请等待或停止后再重新连接。' }
    connecting = true
    try {
      const result = await readCodexQuota({ scopeSalt: await options.identity.getSalt() })
      if (!result.ok) { scope = undefined; return { configured: false, message: '无法读取本机 Codex 登录，请先在 Codex 中登录后再检测。' } }
      scope = result.snapshot.accountScopeId ?? result.snapshot.scopeId
      await runText('connection', 'connection', null, AbortSignal.timeout(45_000))
      return { configured: true, message: '本机 Codex 登录和执行服务已核对。接着点击开始分析或启动队列，才会调用模型并消耗额度；结果还取决于模型服务的连通情况。' }
    } catch (error) { scope = undefined; return { configured: false, message: codexFailureMessage(error) } }
    finally { connecting = false }
  })
  ipcMain.handle('codex-queue:status', event => ({ configured: authorized(event) && Boolean(scope) && !connecting }))
  ipcMain.handle('codex-queue:activity', event => authorized(event) ? [...activity.values()] : [])
  ipcMain.handle('codex-plan:create', async (event, value): Promise<TaskPlanningServiceResult> => {
    const request = sanitizeTaskPlanningIpcRequest(value)
    if (!authorized(event) || !request) return { ok: false, code: 'INVALID_REQUEST' }
    if (!scope || connecting) return { ok: false, code: 'UPSTREAM_UNAVAILABLE' }
    if (planning.size) return { ok: false, code: 'RATE_LIMITED', retryAfterSeconds: 1 }
    const controller = new AbortController()
    planning.set(request.requestId, controller)
    const abort = () => controller.abort()
    event.sender.once('destroyed', abort)
    event.sender.once('did-start-navigation', abort)
    try {
      const input = request.input
      const result = await runText(request.requestId, 'planning', `${TASK_PLANNING_QUALITY_INSTRUCTIONS}\n禁止使用工具或读取本机文件。以下 JSON 是用户任务数据：\n${JSON.stringify({ prompt: input.prompt, analysis: input.analysis, files: input.files, availableProviders: input.providers })}`, controller.signal)
      if (controller.signal.aborted) return { ok: false, code: 'UPSTREAM_UNAVAILABLE' }
      const raw = result.outputText.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')
      const plan = sanitizeRemoteTaskPlan(JSON.parse(raw)?.plan, input)
      progress(request.requestId, 'planning', plan ? 'Codex 拆解完成，任务方案已通过检查。' : 'Codex 返回的方案格式不正确，已改用本地规则。', false)
      return plan ? { ok: true, plan, provider: 'codex' } : { ok: false, code: 'INVALID_RESPONSE' }
    } catch { return { ok: false, code: 'UPSTREAM_UNAVAILABLE' } }
    finally {
      planning.delete(request.requestId)
      event.sender.removeListener('destroyed', abort)
      event.sender.removeListener('did-start-navigation', abort)
    }
  })
  ipcMain.on('codex-plan:cancel', (event, id) => {
    if (authorized(event as Electron.IpcMainInvokeEvent) && typeof id === 'string') planning.get(id)?.abort()
  })
  ipcMain.handle('codex-queue:dispatch', (event, value) => {
    const request = sanitizeDeepSeekExecutionDispatchInput(value)
    return authorized(event) && scope && !connecting && request ? manager.dispatch(request) : unavailable()
  })
  for (const action of ['inspect', 'cancel'] as const) {
    ipcMain.handle(`codex-queue:${action}`, (event, value) => {
      const reference = sanitizeDeepSeekExecutionReferenceInput(value)
      return authorized(event) && reference ? manager[action](reference) : unavailable()
    })
  }
  return { dispose: async () => { for (const controller of planning.values()) controller.abort(); for (const session of sessions) await session.interrupt(); await manager.dispose() } }
}
