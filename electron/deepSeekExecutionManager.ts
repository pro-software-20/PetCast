import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { TASK_PLANNING_QUALITY_INSTRUCTIONS } from './personalPlanningInstructions.js'
import { sanitizeRemoteTaskPlan, type TaskPlanningRequest, type TaskPlanningServiceResult } from './taskPlanningProtocol.js'
import {
  type DeepSeekExecutionDispatchInput,
  type DeepSeekExecutionError,
  type DeepSeekExecutionErrorCode,
  type DeepSeekExecutionOutcome,
  type DeepSeekExecutionReceipt,
  type DeepSeekExecutionReferenceInput,
  type DeepSeekExecutionSnapshot,
} from './deepSeekExecutionProtocol.js'

interface DeepSeekApiResponse {
  choices?: Array<{ message?: { content?: string } }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

interface StoredExecution {
  request: DeepSeekExecutionDispatchInput
  receipt: DeepSeekExecutionReceipt
  snapshot: DeepSeekExecutionSnapshot
}

interface StoredDocument {
  version: 1
  executions: StoredExecution[]
}

export interface DeepSeekExecutionManagerOptions {
  taskRunner?: (request: DeepSeekExecutionDispatchInput, signal: AbortSignal) => Promise<{ outputText: string; usage?: { inputTokens: number; outputTokens: number } }>
  apiKey?: string
  model?: string
  endpoint?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

const safeError = (
  code: DeepSeekExecutionErrorCode,
  message: string,
  retryable = false,
  retryAfterSeconds?: number,
): DeepSeekExecutionError => ({
  code,
  message,
  retryable,
  ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
})

const failure = <T>(error: DeepSeekExecutionError): DeepSeekExecutionOutcome<T> => ({ ok: false, error })
const now = () => new Date().toISOString()
const sameRequest = (left: DeepSeekExecutionDispatchInput, right: DeepSeekExecutionDispatchInput) => (
  JSON.stringify(left) === JSON.stringify(right)
)
const retryAfter = (response: Response) => {
  const raw = response.headers.get('retry-after')
  if (!raw) return undefined
  const seconds = Number(raw)
  return Number.isInteger(seconds) && seconds >= 0 ? seconds : undefined
}
const firstLine = (value: string) => {
  const line = value.trim().split(/\r?\n/)[0]?.replace(/\s+/g, ' ').trim()
  if (!line) return 'DeepSeek 已完成任务。'
  return line.length > 500 ? `${line.slice(0, 499)}…` : line
}

export class DeepSeekExecutionManager {
  private loaded?: Promise<void>
  private readonly executions = new Map<string, StoredExecution>()
  private readonly active = new Map<string, AbortController>()
  private writeQueue: Promise<unknown> = Promise.resolve()
  private disposed = false
  private apiKey: string
  private model: string
  private readonly endpoint: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch
  private readonly taskRunner?: DeepSeekExecutionManagerOptions['taskRunner']

  constructor(private readonly file: string, options: DeepSeekExecutionManagerOptions = {}) {
    this.apiKey = options.apiKey?.trim() ?? ''
    this.model = options.model?.trim() || 'deepseek-flash'
    this.endpoint = options.endpoint?.trim() || 'https://api.deepseek.com/chat/completions'
    this.timeoutMs = options.timeoutMs ?? 120_000
    this.fetchImpl = options.fetchImpl ?? fetch
    this.taskRunner = options.taskRunner
  }

  connectionStatus() { return { configured: Boolean(this.apiKey), model: this.model } }

  async planWithPersonalAccount(input: TaskPlanningRequest, signal: AbortSignal): Promise<TaskPlanningServiceResult> {
    if (signal.aborted) return { ok: false, code: 'UPSTREAM_UNAVAILABLE' }
    if (!this.apiKey) return { ok: false, code: 'UPSTREAM_UNAVAILABLE' }
    const controller = new AbortController()
    const abort = () => controller.abort()
    if (signal.aborted) controller.abort()
    signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(abort, 60000)
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: 'POST', headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model, stream: false, response_format: { type: 'json_object' },
          messages: [{ role: 'system', content: TASK_PLANNING_QUALITY_INSTRUCTIONS },
            { role: 'user', content: JSON.stringify({ prompt: input.prompt, analysis: input.analysis, files: input.files, availableProviders: input.providers }) }] }),
        signal: controller.signal,
      })
      if (!response.ok) return { ok: false, code: response.status === 429 ? 'RATE_LIMITED' : 'UPSTREAM_UNAVAILABLE' }
      const raw = await response.text()
      if (raw.length > 1024 * 1024) return { ok: false, code: 'INVALID_RESPONSE' }
      const content = JSON.parse(raw)?.choices?.[0]?.message?.content
      if (typeof content !== 'string') return { ok: false, code: 'INVALID_RESPONSE' }
      const plan = sanitizeRemoteTaskPlan(JSON.parse(content)?.plan, input)
      return plan ? { ok: true, plan, provider: 'deepseek' } : { ok: false, code: 'INVALID_RESPONSE' }
    } catch { return { ok: false, code: controller.signal.aborted ? 'UPSTREAM_TIMEOUT' : 'INVALID_RESPONSE' } }
    finally { clearTimeout(timer); signal.removeEventListener('abort', abort) }
  }

  async configureAccount(apiKey: string, model: string) {
    await this.load()
    if (this.active.size || [...this.executions.values()].some(e => ['queued', 'running', 'unknown'].includes(e.snapshot.state))) {
      return { ok: false as const, message: '请先停止或核对已有执行，再切换账户。' }
    }
    if (!apiKey.trim() || apiKey.length > 1024 || /[\s\x00-\x1f]/.test(apiKey) || !/^[A-Za-z0-9._:-]{1,100}$/.test(model)) {
      return { ok: false as const, message: '请填写有效的 API Key 和模型名称。' }
    }
    try {
      const response = await this.fetchImpl('https://api.deepseek.com/models', {
        headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15000),
      })
      if (!response.ok) return { ok: false as const, message: response.status === 401 || response.status === 403 ? '账户凭据无效或无访问权限。' : '连接检测失败，请稍后重试。' }
      const raw = await response.text()
      if (raw.length > 100000) return { ok: false as const, message: '模型列表异常。' }
      const value = JSON.parse(raw)
      if (!Array.isArray(value.data) || !value.data.some((m: { id?: string }) => m?.id === model)) {
        return { ok: false as const, message: '此账户未返回指定模型，请核对模型名称。' }
      }
      // Recheck after the network request: configuration must not race a dispatch.
      if (this.active.size || [...this.executions.values()].some(e => ['queued', 'running', 'unknown'].includes(e.snapshot.state))) {
        return { ok: false as const, message: '已有任务开始执行，请停止后再连接。' }
      }
      this.apiKey = apiKey
      this.model = model
      return { ok: true as const, message: '账户和模型检测通过。实际执行仍受余额与限流影响。' }
    } catch { return { ok: false as const, message: '无法连接 DeepSeek，请检查网络后重试。' } }
  }

  private load() {
    return this.loaded ??= (async () => {
      try {
        const parsed = JSON.parse(await fs.readFile(this.file, 'utf8')) as StoredDocument
        if (parsed.version !== 1 || !Array.isArray(parsed.executions)) throw new Error('invalid execution store')
        for (const execution of parsed.executions.slice(-500)) {
          if (!execution?.request?.dispatchId || !execution.receipt || !execution.snapshot) continue
          if (execution.snapshot.state === 'queued' || execution.snapshot.state === 'running') {
            execution.snapshot = {
              dispatchId: execution.receipt.dispatchId,
              adapterExecutionId: execution.receipt.adapterExecutionId,
              taskId: execution.receipt.taskId,
              state: 'unknown',
              observedAt: now(),
              error: safeError(
                'EXECUTION_NOT_FOUND',
                '应用重启后无法确认此前在途执行，已禁止自动重新调用。',
              ),
            }
          }
          this.executions.set(execution.request.dispatchId, execution)
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          await fs.rename(this.file, `${this.file}.corrupt-${Date.now()}`).catch(() => undefined)
        }
      }
      await this.persist()
    })()
  }

  private persist() {
    const operation = this.writeQueue.then(async () => {
      const document: StoredDocument = {
        version: 1,
        executions: [...this.executions.values()].slice(-500),
      }
      await fs.mkdir(path.dirname(this.file), { recursive: true })
      const temporary = `${this.file}.${randomUUID()}.tmp`
      try {
        const handle = await fs.open(temporary, 'wx', 0o600)
        try {
          await handle.writeFile(JSON.stringify(document))
          await handle.sync()
        } finally {
          await handle.close()
        }
        await fs.rename(temporary, this.file)
      } finally {
        await fs.unlink(temporary).catch(() => undefined)
      }
    })
    this.writeQueue = operation.catch(() => undefined)
    return operation
  }

  async dispatch(
    request: DeepSeekExecutionDispatchInput,
  ): Promise<DeepSeekExecutionOutcome<DeepSeekExecutionReceipt>> {
    await this.load()
    if (this.disposed) return failure(safeError('UNAVAILABLE', 'DeepSeek 执行服务当前不可用。', true))
    const existing = this.executions.get(request.dispatchId)
    if (existing) {
      return sameRequest(existing.request, request)
        ? { ok: true, value: structuredClone(existing.receipt) }
        : failure(safeError('INVALID_INPUT', '同一 dispatchId 不能对应不同执行请求。'))
    }
    if (!this.apiKey && !this.taskRunner) return failure(safeError('UNAVAILABLE', '执行账户尚未配置。', true))

    const acceptedAt = now()
    const receipt: DeepSeekExecutionReceipt = {
      dispatchId: request.dispatchId,
      adapterExecutionId: randomUUID(),
      taskId: request.taskId,
      state: 'queued',
      acceptedAt,
    }
    const stored: StoredExecution = {
      request: structuredClone(request),
      receipt,
      snapshot: {
        dispatchId: receipt.dispatchId,
        adapterExecutionId: receipt.adapterExecutionId,
        taskId: receipt.taskId,
        state: 'queued',
        observedAt: acceptedAt,
      },
    }
    this.executions.set(request.dispatchId, stored)
    try {
      await this.persist()
    } catch {
      this.executions.delete(request.dispatchId)
      return failure(safeError('UNAVAILABLE', '执行记录无法安全保存，未调用 DeepSeek。', true))
    }
    void this.run(stored)
    return { ok: true, value: structuredClone(receipt) }
  }

  async inspect(
    reference: DeepSeekExecutionReferenceInput,
  ): Promise<DeepSeekExecutionOutcome<DeepSeekExecutionSnapshot>> {
    await this.load()
    await this.writeQueue
    const stored = this.find(reference)
    return stored
      ? { ok: true, value: structuredClone(stored.snapshot) }
      : failure(safeError('EXECUTION_NOT_FOUND', '未找到匹配的 DeepSeek 执行记录。'))
  }

  async cancel(
    reference: DeepSeekExecutionReferenceInput,
  ): Promise<DeepSeekExecutionOutcome<DeepSeekExecutionSnapshot>> {
    await this.load()
    const stored = this.find(reference)
    if (!stored) return failure(safeError('EXECUTION_NOT_FOUND', '未找到匹配的 DeepSeek 执行记录。'))
    if (!['completed', 'failed', 'cancelled'].includes(stored.snapshot.state)) {
      this.active.get(reference.dispatchId)?.abort()
      stored.snapshot = {
        ...reference,
        state: 'cancelled',
        observedAt: now(),
        error: safeError('CANCELLED', 'DeepSeek 执行已取消。'),
      }
      await this.persist().catch(() => undefined)
    }
    return { ok: true, value: structuredClone(stored.snapshot) }
  }

  private find(reference: DeepSeekExecutionReferenceInput) {
    const stored = this.executions.get(reference.dispatchId)
    return stored
      && stored.receipt.adapterExecutionId === reference.adapterExecutionId
      && stored.receipt.taskId === reference.taskId
      ? stored
      : undefined
  }

  private async run(stored: StoredExecution) {
    const controller = new AbortController()
    this.active.set(stored.request.dispatchId, controller)
    stored.snapshot = {
      dispatchId: stored.receipt.dispatchId,
      adapterExecutionId: stored.receipt.adapterExecutionId,
      taskId: stored.receipt.taskId,
      state: 'running',
      observedAt: now(),
    }
    await this.persist().catch(() => undefined)
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    timer.unref?.()
    try {
      const dependencyText = stored.request.dependencySummaries.length
        ? `\n\n直接前置任务摘要：\n${stored.request.dependencySummaries.map(item => `- ${item}`).join('\n')}`
        : ''
      const acceptanceText = stored.request.acceptanceChecks.length
        ? `\n\n验收标准：\n${stored.request.acceptanceChecks.map(item => `- ${item}`).join('\n')}`
        : ''
      let payload: DeepSeekApiResponse
      if (this.taskRunner) {
        const result = await this.taskRunner(stored.request, controller.signal)
        payload = { choices: [{ message: { content: result.outputText } }], ...(result.usage ? { usage: { prompt_tokens: result.usage.inputTokens, completion_tokens: result.usage.outputTokens } } : {}) }
      } else {
      const response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            {
              role: 'system',
              content: '你是 PetCast 的任务执行器。只完成给定任务；不要声称修改本机文件；输出清晰、可交付的正文。',
            },
            {
              role: 'user',
              content: `任务：${stored.request.title}\n\n说明：${stored.request.description}\n\n执行要求：${stored.request.prompt}${dependencyText}${acceptanceText}`,
            },
          ],
          stream: false,
        }),
        signal: controller.signal,
      })
      if (!response.ok) {
        const error = response.status === 429
          ? safeError('RATE_LIMITED', 'DeepSeek 请求受到速率限制。', true, retryAfter(response) ?? 30)
          : response.status === 401 || response.status === 403
            ? safeError('UNAVAILABLE', 'DeepSeek API 配置无效或无权访问。')
            : response.status >= 500
              ? safeError('UNAVAILABLE', 'DeepSeek 服务暂时不可用。', true)
              : safeError('FAILED', 'DeepSeek 未能完成任务。')
        stored.snapshot = {
          dispatchId: stored.receipt.dispatchId,
          adapterExecutionId: stored.receipt.adapterExecutionId,
          taskId: stored.receipt.taskId,
          state: 'failed',
          observedAt: now(),
          error,
        }
        return
      }
      const raw = await response.text()
      if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error('response too large')
      payload = JSON.parse(raw) as DeepSeekApiResponse
      }
      if (controller.signal.aborted || stored.snapshot.state === 'cancelled') return
      const outputText = payload.choices?.[0]?.message?.content?.trim()
      if (!outputText || outputText.length > 50_000) {
        stored.snapshot = {
          dispatchId: stored.receipt.dispatchId,
          adapterExecutionId: stored.receipt.adapterExecutionId,
          taskId: stored.receipt.taskId,
          state: 'failed',
          observedAt: now(),
          error: safeError('INVALID_RESPONSE', 'DeepSeek 返回了无法安全处理的结果。'),
        }
        return
      }
      stored.snapshot = {
        dispatchId: stored.receipt.dispatchId,
        adapterExecutionId: stored.receipt.adapterExecutionId,
        taskId: stored.receipt.taskId,
        state: 'completed',
        observedAt: now(),
        result: {
          summary: firstLine(outputText),
          outputText,
          verification: stored.request.acceptanceChecks.map(label => ({
            label,
            status: 'not-run',
            details: '等待 B/D 或用户按验收标准复核。',
          })),
          ...(payload.usage ? {
            usage: {
              ...(Number.isInteger(payload.usage.prompt_tokens) && Number(payload.usage.prompt_tokens) >= 0
                ? { inputTokens: payload.usage.prompt_tokens } : {}),
              ...(Number.isInteger(payload.usage.completion_tokens) && Number(payload.usage.completion_tokens) >= 0
                ? { outputTokens: payload.usage.completion_tokens } : {}),
            },
          } : {}),
        },
      }
    } catch (error) {
      if (stored.snapshot.state === 'cancelled') return
      const timedOut = controller.signal.aborted
      stored.snapshot = {
        dispatchId: stored.receipt.dispatchId,
        adapterExecutionId: stored.receipt.adapterExecutionId,
        taskId: stored.receipt.taskId,
        state: 'failed',
        observedAt: now(),
        error: timedOut
          ? safeError('TIMEOUT', 'DeepSeek 执行超时。', true)
          : safeError('FAILED', 'DeepSeek 执行发生安全封装后的错误。', true),
      }
    } finally {
      clearTimeout(timer)
      this.active.delete(stored.request.dispatchId)
      await this.persist().catch(() => undefined)
    }
  }

  async dispose() {
    this.disposed = true
    for (const controller of this.active.values()) controller.abort()
    await Promise.all([...this.active.keys()].map(async dispatchId => {
      const stored = this.executions.get(dispatchId)
      if (stored && ['queued', 'running'].includes(stored.snapshot.state)) {
        stored.snapshot = {
          dispatchId: stored.receipt.dispatchId,
          adapterExecutionId: stored.receipt.adapterExecutionId,
          taskId: stored.receipt.taskId,
          state: 'cancelled',
          observedAt: now(),
          error: safeError('CANCELLED', '应用关闭时已取消 DeepSeek 执行。'),
        }
      }
    }))
    this.active.clear()
    await this.persist().catch(() => undefined)
  }
}
