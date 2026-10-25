import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { CodexScopeIdentity } from './codexScopeIdentity.js'
import { resolveCodexExecutable } from './codexUsage.js'

export class CodexAppServerError extends Error {
  constructor(readonly code: 'CODEX_UNAVAILABLE' | 'ACCOUNT_MISMATCH' | 'TIMEOUT' | 'CANCELLED' | 'PROVIDER_FAILED') {
    super(code)
  }
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

interface CodexRunResult {
  outputText: string
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number | null } | null
}

export type CodexAppServerAuth =
  | { mode: 'chatgpt-oauth'; accessToken: string }
  | { mode: 'local-codex-experimental' }

const object = (value: unknown): Record<string, unknown> | undefined => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
)

const childEnvironment = (accessToken?: string) => {
  const allowed = new Set([
    'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'USERPROFILE', 'HOME',
    'APPDATA', 'LOCALAPPDATA', 'CODEX_HOME', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'TERM',
  ])
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toUpperCase()))),
    ...(accessToken ? { ACCESS_TOKEN: accessToken } : {}),
  }
}

export class CodexAppServerSession {
  private child?: ChildProcessWithoutNullStreams
  private pending = new Map<number, PendingRequest>()
  private nextId = 0
  private buffer = ''
  private receivedBytes = 0
  private terminal?: Error
  private threadId?: string
  private turnId?: string
  private output = ''
  private usage: CodexRunResult['usage'] = null
  private completion?: { resolve: () => void; reject: (error: Error) => void }
  private pendingCompletionStatus?: unknown
  private turnTerminalReceived = false

  constructor(
    private readonly cwd: string,
    private readonly identity: CodexScopeIdentity,
    private readonly onProgress: (message: string) => void,
    private readonly launch?: (
      executable: string,
      cwd: string,
      args: string[],
      environment: NodeJS.ProcessEnv,
    ) => ChildProcessWithoutNullStreams,
    private readonly resolveExecutable: typeof resolveCodexExecutable = resolveCodexExecutable,
  ) {}

  private fail(error: Error) {
    if (this.terminal) return
    this.terminal = error
    for (const request of this.pending.values()) request.reject(error)
    this.pending.clear()
    this.completion?.reject(error)
    this.completion = undefined
  }

  private redact(value: string) {
    const variants = [this.cwd, this.cwd.replace(/\\/g, '/')].filter(Boolean)
    return variants.reduce((text, privatePath) => text.split(privatePath).join('[isolated-workspace]'), value)
  }

  private send(value: unknown) {
    if (!this.child || this.terminal) throw this.terminal ?? new CodexAppServerError('CODEX_UNAVAILABLE')
    this.child.stdin.write(`${JSON.stringify(value)}\n`)
  }

  private request(method: string, params: unknown) {
    return new Promise<unknown>((resolve, reject) => {
      const id = ++this.nextId
      this.pending.set(id, { resolve, reject })
      this.send({ id, method, params })
    })
  }

  private receiveLine(line: string) {
    let message: Record<string, unknown>
    try {
      const parsed = object(JSON.parse(line))
      if (!parsed) throw new Error()
      message = parsed
    } catch {
      this.fail(new CodexAppServerError('PROVIDER_FAILED'))
      return
    }
    if (typeof message.method === 'string') {
      if (message.id !== undefined) {
        // approvalPolicy=never means requests are unexpected; fail closed.
        this.send({ id: message.id, error: { code: -32000, message: 'Approval unavailable' } })
        return
      }
      this.notification(message.method, object(message.params) ?? {})
      return
    }
    const id = message.id
    if (typeof id !== 'number') return
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    if (Object.hasOwn(message, 'error') === Object.hasOwn(message, 'result')) {
      pending.reject(new CodexAppServerError('PROVIDER_FAILED'))
    } else if (Object.hasOwn(message, 'error')) {
      pending.reject(new CodexAppServerError('PROVIDER_FAILED'))
    } else pending.resolve(message.result)
  }

  private notification(method: string, params: Record<string, unknown>) {
    if (method === 'item/agentMessage/delta') {
      const delta = params.delta
      if (typeof delta === 'string') {
        this.output = this.redact(`${this.output}${delta}`).slice(0, 50_000)
        this.onProgress('Codex 正在生成结果…')
      }
      return
    }
    if (method === 'item/completed' && !this.output) {
      const item = object(params.item)
      const text = item?.text ?? item?.message
      if (item?.type === 'agentMessage' && typeof text === 'string') this.output = this.redact(text).slice(0, 50_000)
      return
    }
    if (method === 'thread/tokenUsage/updated') {
      const usage = object(params.tokenUsage) ?? object(params.usage) ?? params
      const total = object(usage.total) ?? object(usage.totalUsage) ?? usage
      const input = total.inputTokens ?? total.input_tokens
      const output = total.outputTokens ?? total.output_tokens
      const cached = total.cachedInputTokens ?? total.cached_input_tokens
      const cachedValid = cached == null || (Number.isSafeInteger(cached) && Number(cached) >= 0 && Number(cached) <= Number(input))
      if (Number.isSafeInteger(input) && Number(input) >= 0 && Number.isSafeInteger(output) && Number(output) >= 0 && cachedValid) {
        this.usage = {
          inputTokens: Number(input),
          outputTokens: Number(output),
          cachedInputTokens: cached == null ? null : Number(cached),
        }
      }
      return
    }
    if (method === 'turn/completed') {
      if (this.turnTerminalReceived) return
      this.turnTerminalReceived = true
      const turn = object(params.turn)
      const status = turn?.status
      this.onProgress(status === 'completed'
        ? 'Codex 已完成隔离执行。'
        : status === 'interrupted' ? 'Codex 执行已中断。' : 'Codex 未能完成隔离执行。')
      if (!this.completion) this.pendingCompletionStatus = status
      else {
        if (status === 'completed') this.completion.resolve()
        else if (status === 'interrupted') this.completion.reject(new CodexAppServerError('CANCELLED'))
        else this.completion.reject(new CodexAppServerError('PROVIDER_FAILED'))
        this.completion = undefined
      }
      return
    }
    if (method.includes('command') || method.includes('tool')) this.onProgress('Codex 正在隔离副本中检查和修改文件…')
  }

  async prepare(expectedScopeId: string, auth: CodexAppServerAuth = { mode: 'local-codex-experimental' }) {
    const executable = (await this.resolveExecutable()).executable
    const args = auth.mode === 'chatgpt-oauth'
      ? [
          'app-server', '--listen', 'stdio://',
          '-c', 'model_provider="openai_chatgpt_plan"',
          '-c', 'model_providers.openai_chatgpt_plan.name="ChatGPT plan"',
          '-c', 'model_providers.openai_chatgpt_plan.base_url="https://api.openai.com/v1"',
          '-c', 'model_providers.openai_chatgpt_plan.env_key="ACCESS_TOKEN"',
          '-c', 'model_providers.openai_chatgpt_plan.wire_api="responses"',
          '-c', 'model_providers.openai_chatgpt_plan.requires_openai_auth=false',
          '-c', 'model_providers.openai_chatgpt_plan.supports_websockets=false',
        ]
      : ['app-server', '--listen', 'stdio://']
    const environment = childEnvironment(auth.mode === 'chatgpt-oauth' ? auth.accessToken : undefined)
    this.child = this.launch?.(executable, this.cwd, args, environment) ?? spawn(executable, args, {
      cwd: this.cwd,
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: environment,
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => {
      this.receivedBytes += Buffer.byteLength(chunk)
      if (this.receivedBytes > 10 * 1024 * 1024) return this.fail(new CodexAppServerError('PROVIDER_FAILED'))
      this.buffer += chunk
      let newline = this.buffer.indexOf('\n')
      while (newline >= 0) {
        const line = this.buffer.slice(0, newline).trim()
        this.buffer = this.buffer.slice(newline + 1)
        if (line) this.receiveLine(line)
        newline = this.buffer.indexOf('\n')
      }
    })
    this.child.stderr.on('data', () => {})
    this.child.on('error', () => this.fail(new CodexAppServerError('CODEX_UNAVAILABLE')))
    this.child.on('exit', () => this.fail(new CodexAppServerError('CODEX_UNAVAILABLE')))
    await this.request('initialize', {
      clientInfo: { name: 'petcast', title: 'PetCast', version: '0.1.0' },
      capabilities: null,
    })
    this.send({ method: 'initialized', params: {} })
    if (auth.mode === 'local-codex-experimental') {
      this.onProgress('Codex 服务已连接，正在核对本机登录…')
      const account = object(await this.request('account/read', { refreshToken: false }))
      const accountValue = object(account?.account)
      if (accountValue?.type !== 'chatgpt' || typeof accountValue.email !== 'string') {
        throw new CodexAppServerError('CODEX_UNAVAILABLE')
      }
      const limits = object(await this.request('account/rateLimits/read', {}))
      const accountId = typeof limits?.accountId === 'string' && limits.accountId.trim() ? limits.accountId : undefined
      const actualScopeId = await this.identity.hashAccount(accountValue.email, accountId)
      if (actualScopeId !== expectedScopeId) throw new CodexAppServerError('ACCOUNT_MISMATCH')
    } else {
      this.onProgress('ChatGPT 授权已核对，正在创建隔离线程…')
    }
    this.onProgress('Codex 账号已核对，正在创建隔离线程…')
    const thread = object(await this.request('thread/start', {
      cwd: this.cwd,
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      ephemeral: true,
    }))
    const threadValue = object(thread?.thread)
    if (typeof threadValue?.id !== 'string') throw new CodexAppServerError('PROVIDER_FAILED')
    this.onProgress('Codex 隔离线程已准备完成。')
    this.threadId = threadValue.id
    const rawModel = typeof threadValue.model === 'string'
      ? threadValue.model
      : typeof thread?.model === 'string' ? thread.model : 'codex'
    const model = rawModel.length <= 100 && !/[\u0000-\u001f]/.test(rawModel) ? rawModel : 'codex'
    return model
  }

  async run(prompt: string, timeoutMs = 10 * 60_000): Promise<CodexRunResult> {
    if (!this.threadId) throw new CodexAppServerError('PROVIDER_FAILED')
    this.output = ''
    this.usage = null
    this.pendingCompletionStatus = undefined
    this.turnTerminalReceived = false
    const response = object(await this.request('turn/start', {
      threadId: this.threadId,
      input: [{ type: 'text', text: prompt, text_elements: [] }],
      cwd: this.cwd,
      approvalPolicy: 'never',
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: [this.cwd],
        networkAccess: false,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      },
    }))
    const turn = object(response?.turn)
    if (typeof turn?.id !== 'string') throw new CodexAppServerError('PROVIDER_FAILED')
    this.turnId = turn.id
    this.onProgress('Codex 已接受任务，正在隔离副本中执行。')
    await new Promise<void>((resolve, reject) => {
      this.completion = { resolve, reject }
      const timer = setTimeout(() => {
        if (this.completion) {
          this.completion = undefined
          reject(new CodexAppServerError('TIMEOUT'))
          void this.interrupt()
        }
      }, timeoutMs)
      const clear = () => clearTimeout(timer)
      const originalResolve = this.completion.resolve
      const originalReject = this.completion.reject
      this.completion.resolve = () => { clear(); originalResolve() }
      this.completion.reject = error => { clear(); originalReject(error) }
      if (this.pendingCompletionStatus !== undefined) {
        const status = this.pendingCompletionStatus
        this.pendingCompletionStatus = undefined
        const completion = this.completion
        this.completion = undefined
        if (status === 'completed') completion.resolve()
        else if (status === 'interrupted') completion.reject(new CodexAppServerError('CANCELLED'))
        else completion.reject(new CodexAppServerError('PROVIDER_FAILED'))
      }
    })
    return { outputText: this.output.trim(), usage: this.usage }
  }

  async interrupt() {
    if (this.threadId && this.turnId && this.child && !this.child.killed) {
      try {
        await Promise.race([
          this.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }),
          new Promise(resolve => setTimeout(resolve, 3_000)),
        ])
      } catch { /* kill below */ }
    }
    this.fail(new CodexAppServerError('CANCELLED'))
    this.close()
  }

  close() {
    this.child?.stdin.end()
    this.child?.kill()
    this.child = undefined
  }
}
