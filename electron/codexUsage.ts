import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { access, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import type { CodexQuotaResult, CodexQuotaSnapshot, CodexUsageErrorCode } from './codexProtocol.js'
import { createCodexDiagnostics } from './codexDiagnostics.js'

export class CodexReadError extends Error {
  constructor(readonly code: CodexUsageErrorCode) { super(code) }
}
const fail = (code: CodexUsageErrorCode): never => { throw new CodexReadError(code) }
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('INVALID_RESPONSE')
  return value as Record<string, unknown>
}

/** Match by duration, never assume primary is five hours. Prefer the explicit Codex bucket. */
export function normalizeCodexLimits(value: unknown, scopeId: string, now = new Date()): CodexQuotaSnapshot {
  const response = record(value)
  const buckets = response.rateLimitsByLimitId
  const bucket = record(buckets == null ? response.rateLimits : record(buckets).codex)
  if (bucket.limitId != null && bucket.limitId !== 'codex') return fail('UNSUPPORTED_WINDOWS')
  const windows = [bucket.primary, bucket.secondary].filter(value => value != null).map(record)
  const windowFor = (minutes: number) => {
    const matches = windows.filter(window => window.windowDurationMins === minutes)
    if (matches.length !== 1) return fail('UNSUPPORTED_WINDOWS')
    const window = matches[0]
    if (typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent) || window.usedPercent < 0) return fail('INVALID_RESPONSE')
    if (typeof window.resetsAt !== 'number' || !Number.isSafeInteger(window.resetsAt) || window.resetsAt <= 0) return fail('INVALID_RESPONSE')
    const reset = new Date(window.resetsAt * 1000)
    if (!Number.isFinite(reset.getTime())) return fail('INVALID_RESPONSE')
    // No refill on the client clock; the server may return an elapsed window.
    return { remaining: Math.max(0, Math.min(100, 100 - window.usedPercent)), reset: reset.toISOString() }
  }
  const short = windowFor(300), weekly = windowFor(10080)
  return {
    scopeId, sampledAt: now.toISOString(),
    shortWindowRemaining: short.remaining, weeklyRemaining: weekly.remaining,
    shortWindowResetAt: short.reset, weeklyResetAt: weekly.reset,
  }
}

export async function resolveCodexExecutable(env: NodeJS.ProcessEnv = process.env): Promise<{ executable: string; source: 'override' | 'path' | 'desktop' }> {
  const exists = async (file: string) => {
    try { await access(file); return (await stat(file)).isFile() } catch { return false }
  }
  if (env.PETCAST_CODEX_PATH) {
    if (path.isAbsolute(env.PETCAST_CODEX_PATH) && await exists(env.PETCAST_CODEX_PATH)) return { executable: env.PETCAST_CODEX_PATH, source: 'override' }
    return fail('CLI_NOT_FOUND')
  }
  const names = process.platform === 'win32' ? ['codex.exe'] : ['codex']
  for (const dir of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = path.join(dir, name)
      if (await exists(candidate)) return { executable: candidate, source: 'path' }
    }
  }
  if (process.platform === 'win32' && env.LOCALAPPDATA) {
    const bin = path.join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin')
    const entries = await readdir(bin, { withFileTypes: true }).catch(() => [])
    const candidates = await Promise.all(entries.filter(entry => entry.isDirectory()).map(async entry => {
      const file = path.join(bin, entry.name, 'codex.exe')
      return { file, modified: await stat(file).then(value => value.mtimeMs).catch(() => 0) }
    }))
    candidates.sort((a, b) => b.modified - a.modified)
    for (const candidate of candidates) if (candidate.modified && await exists(candidate.file)) return { executable: candidate.file, source: 'desktop' }
  }
  return fail('CLI_NOT_FOUND')
}

export async function findCodexExecutable(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return (await resolveCodexExecutable(env)).executable
}

type Launch = (executable: string) => ChildProcessWithoutNullStreams
/** A short-lived stdio session: read-only account APIs, never starts an inference turn. */
export async function readCodexQuota(options: {
  scopeSalt: string
  signal?: AbortSignal
  timeoutMs?: number
  executable?: string
  launch?: Launch
  resolveExecutable?: typeof resolveCodexExecutable
}): Promise<CodexQuotaResult> {
  let child: ChildProcessWithoutNullStreams | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  let terminal: Error | undefined
  let scopeId: string | undefined
  let accountScopeId: string | undefined
  let rejectDiscovery: ((error: Error) => void) | undefined
  const stop = (code: CodexUsageErrorCode) => {
    terminal ??= new CodexReadError(code)
    rejectDiscovery?.(terminal)
    for (const request of pending.values()) request.reject(terminal)
    pending.clear()
    child?.kill()
  }
  try {
    if (options.signal?.aborted) return fail('CANCELLED')
    timer = setTimeout(() => stop('TIMEOUT'), options.timeoutMs ?? 15_000)
    abort = () => stop('CANCELLED')
    options.signal?.addEventListener('abort', abort, { once: true })
    const resolved = options.executable ? { executable: options.executable, source: 'explicit' as const }
      : await new Promise<Awaited<ReturnType<typeof resolveCodexExecutable>>>((resolve, reject) => {
        rejectDiscovery = reject
        // Discovery can touch slow/disconnected PATH locations. A late result must never launch a process.
        Promise.resolve().then(() => (options.resolveExecutable ?? resolveCodexExecutable)()).then(resolve, reject)
      })
    rejectDiscovery = undefined
    const executable = resolved.executable
    if (options.signal?.aborted) return fail('CANCELLED')
    if (terminal) throw terminal
    child = (options.launch ?? (exe => spawn(exe, ['app-server', '--listen', 'stdio://'], {
      windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
    })))(executable)
    if (options.signal?.aborted) stop('CANCELLED')
    child.on('error', () => stop('UNAVAILABLE'))
    child.on('exit', () => stop('UNAVAILABLE'))
    child.stdin.on('error', () => stop('UNAVAILABLE'))
    child.stdout.on('error', () => stop('UNAVAILABLE'))
    // Drain but never log stderr: upstream diagnostics may include private paths or account data.
    child.stderr.on('data', () => {})
    child.stderr.on('error', () => stop('UNAVAILABLE'))
    child.stdout.setEncoding('utf8')
    let buffer = '', received = 0, id = 0
    child.stdout.on('data', (text: string) => {
      received += Buffer.byteLength(text)
      if (received > 1_048_576) return stop('INVALID_RESPONSE')
      buffer += text
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)
        if (!line.trim()) continue
        let message: Record<string, unknown>
        try { message = record(JSON.parse(line)) } catch { stop('INVALID_RESPONSE'); return }
        // Server requests use their own ID space. Never resolve one of our pending reads with them.
        if (typeof message.method === 'string') {
          if (message.id !== undefined) child!.stdin.write(JSON.stringify({ id: message.id,
            error: { code: -32601, message: 'Unsupported client method' } }) + '\n')
          continue
        }
        const request = pending.get(message.id as number)
        if (!request) continue // Notifications are irrelevant to this reader.
        pending.delete(message.id as number)
        if (Object.hasOwn(message, 'error') === Object.hasOwn(message, 'result')) request.reject(new CodexReadError('INVALID_RESPONSE'))
        else if (Object.hasOwn(message, 'error')) request.reject(new CodexReadError('UNAVAILABLE'))
        else request.resolve(message.result)
      }
    })
    const send = (value: unknown) => child!.stdin.write(JSON.stringify(value) + '\n')
    const request = (method: string, params: unknown) => new Promise<unknown>((resolve, reject) => {
      if (terminal) return reject(terminal)
      const requestId = ++id
      pending.set(requestId, { resolve, reject })
      send({ id: requestId, method, params })
    })
    await request('initialize', { clientInfo: { name: 'petcast', title: 'PetCast', version: '0.1.0' } })
    send({ method: 'initialized', params: {} })
    const identity = (value: unknown) => {
      const accountValue = record(value).account
      if (accountValue == null) return fail('LOGIN_REQUIRED')
      const account = record(accountValue)
      if (account.type !== 'chatgpt') return fail('UNSUPPORTED_ACCOUNT')
      // account/read exposes email, not a stable account ID. It stays in the main process.
      if (typeof account.email !== 'string' || !account.email.trim()) return fail('INVALID_RESPONSE')
      return account.email.trim().toLowerCase()
    }
    const accountBefore = await request('account/read', { refreshToken: false })
    const before = identity(accountBefore)
    scopeId = 'codex-' + createHmac('sha256', options.scopeSalt).update(before).digest('hex')
    const limits = await request('account/rateLimits/read', {})
    // Some versions supply an account ID that distinguishes workspaces sharing one email.
    // Hash it locally; neither the raw ID nor email crosses IPC.
    const accountId = record(limits).accountId
    if (accountId != null) {
      if (typeof accountId !== 'string' || !accountId.trim()) return fail('INVALID_RESPONSE')
      accountScopeId = 'codex-' + createHmac('sha256', options.scopeSalt)
        .update(JSON.stringify([before, accountId])).digest('hex')
    }
    const after = identity(await request('account/read', { refreshToken: false }))
    if (before !== after) { scopeId = undefined; accountScopeId = undefined; return fail('ACCOUNT_CHANGED') }
    return { ok: true, snapshot: { ...normalizeCodexLimits(limits, scopeId), accountScopeId,
      diagnostics: createCodexDiagnostics(accountBefore, limits, resolved.source, Boolean(process.env.CODEX_HOME)) } }
  } catch (error) {
    return { ok: false, code: error instanceof CodexReadError ? error.code : 'UNAVAILABLE', scopeId, accountScopeId }
  } finally {
    clearTimeout(timer)
    rejectDiscovery = undefined
    if (abort) options.signal?.removeEventListener('abort', abort)
    child?.stdin.end()
    child?.kill()
  }
}
