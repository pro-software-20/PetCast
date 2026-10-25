import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { CodexScopeIdentity } from './codexScopeIdentity.js'
import { CodexReadError, resolveCodexExecutable } from './codexUsage.js'
import {
  MINIMUM_CODEX_VERSION,
  type CodexEnvironmentErrorCode,
  type CodexEnvironmentResult,
} from './codexEnvironmentProtocol.js'
import type { ChatGptSessionResult } from './chatGptAuthProtocol.js'

type Launch = (executable: string, args: string[]) => ChildProcessWithoutNullStreams

export class CodexEnvironmentError extends Error {
  constructor(readonly code: CodexEnvironmentErrorCode) { super(code) }
}

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CodexEnvironmentError('INVALID_RESPONSE')
  }
  return value as Record<string, unknown>
}

export function parseCodexVersion(value: string): string | null {
  if (value.length > 4_096) return null
  const match = value.trim().match(/^codex-cli\s+(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/)
  if (!match) return null
  const parts = match.slice(1, 4).map(Number)
  if (parts.some(part => !Number.isSafeInteger(part))) return null
  return parts.join('.')
}

export function isSupportedCodexVersion(version: string, minimum = MINIMUM_CODEX_VERSION): boolean {
  const parse = (value: string) => value.split('.').map(Number)
  const current = parse(version), required = parse(minimum)
  if (current.length !== 3 || required.length !== 3
    || [...current, ...required].some(part => !Number.isSafeInteger(part) || part < 0)) return false
  for (let index = 0; index < 3; index += 1) {
    if (current[index] !== required[index]) return current[index] > required[index]
  }
  return true
}

const defaultLaunch: Launch = (executable, args) => spawn(executable, args, {
  windowsHide: true,
  shell: false,
  stdio: ['pipe', 'pipe', 'pipe'],
})

const readVersion = (executable: string, signal: AbortSignal, launch: Launch) => new Promise<string>((resolve, reject) => {
  if (signal.aborted) return reject(new CodexEnvironmentError('CANCELLED'))
  const child = launch(executable, ['--version'])
  let output = '', settled = false
  const finish = (action: () => void) => {
    if (settled) return
    settled = true
    signal.removeEventListener('abort', cancel)
    action()
  }
  const cancel = () => {
    child.kill()
    finish(() => reject(new CodexEnvironmentError('CANCELLED')))
  }
  signal.addEventListener('abort', cancel, { once: true })
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    output += chunk
    if (Buffer.byteLength(output) > 4_096) {
      child.kill()
      finish(() => reject(new CodexEnvironmentError('INVALID_RESPONSE')))
    }
  })
  // Never surface stderr: it may contain private local paths.
  child.stderr.on('data', () => {})
  child.on('error', () => finish(() => reject(new CodexEnvironmentError('UNAVAILABLE'))))
  child.on('close', code => finish(() => {
    const version = code === 0 ? parseCodexVersion(output) : null
    if (!version) reject(new CodexEnvironmentError('INVALID_RESPONSE'))
    else resolve(version)
  }))
})

const readAccountScope = (
  executable: string,
  signal: AbortSignal,
  identity: CodexScopeIdentity,
  launch: Launch,
) => new Promise<string>((resolve, reject) => {
  if (signal.aborted) return reject(new CodexEnvironmentError('CANCELLED'))
  const child = launch(executable, ['app-server', '--listen', 'stdio://'])
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  let nextId = 0, buffer = '', received = 0, settled = false
  const finish = (action: () => void) => {
    if (settled) return
    settled = true
    signal.removeEventListener('abort', cancel)
    for (const request of pending.values()) request.reject(new CodexEnvironmentError('UNAVAILABLE'))
    pending.clear()
    child.stdin.end()
    child.kill()
    action()
  }
  const fail = (code: CodexEnvironmentErrorCode) => finish(() => reject(new CodexEnvironmentError(code)))
  const cancel = () => fail('CANCELLED')
  signal.addEventListener('abort', cancel, { once: true })
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    received += Buffer.byteLength(chunk)
    if (received > 1_048_576) return fail('INVALID_RESPONSE')
    buffer += chunk
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
      if (!line) continue
      let message: Record<string, unknown>
      try { message = object(JSON.parse(line)) } catch { fail('INVALID_RESPONSE'); return }
      if (typeof message.method === 'string') {
        if (message.id !== undefined) child.stdin.write(`${JSON.stringify({
          id: message.id,
          error: { code: -32601, message: 'Unsupported client method' },
        })}\n`)
        continue
      }
      if (typeof message.id !== 'number') continue
      const request = pending.get(message.id)
      if (!request) continue
      pending.delete(message.id)
      if (Object.hasOwn(message, 'error') === Object.hasOwn(message, 'result')) {
        request.reject(new CodexEnvironmentError('INVALID_RESPONSE'))
      } else if (Object.hasOwn(message, 'error')) {
        request.reject(new CodexEnvironmentError('UNAVAILABLE'))
      } else request.resolve(message.result)
    }
  })
  child.stderr.on('data', () => {})
  child.on('error', () => fail('UNAVAILABLE'))
  child.on('exit', () => fail('UNAVAILABLE'))
  child.stdin.on('error', () => fail('UNAVAILABLE'))

  const send = (value: unknown) => child.stdin.write(`${JSON.stringify(value)}\n`)
  const request = (method: string, params: unknown) => new Promise<unknown>((requestResolve, requestReject) => {
    if (settled) return requestReject(new CodexEnvironmentError('UNAVAILABLE'))
    const id = ++nextId
    pending.set(id, { resolve: requestResolve, reject: requestReject })
    send({ id, method, params })
  })
  const accountEmail = (value: unknown) => {
    const accountValue = object(value).account
    if (accountValue == null) throw new CodexEnvironmentError('LOGIN_REQUIRED')
    const account = object(accountValue)
    if (account.type !== 'chatgpt') throw new CodexEnvironmentError('UNSUPPORTED_ACCOUNT')
    if (typeof account.email !== 'string' || !account.email.trim()) {
      throw new CodexEnvironmentError('INVALID_RESPONSE')
    }
    return account.email.trim().toLowerCase()
  }

  void (async () => {
    try {
      await request('initialize', {
        clientInfo: { name: 'petcast', title: 'PetCast', version: '0.1.0' },
        capabilities: null,
      })
      send({ method: 'initialized', params: {} })
      const before = accountEmail(await request('account/read', { refreshToken: false }))
      const limits = object(await request('account/rateLimits/read', {}))
      const rawAccountId = limits.accountId
      if (rawAccountId != null && (typeof rawAccountId !== 'string' || !rawAccountId.trim())) {
        throw new CodexEnvironmentError('INVALID_RESPONSE')
      }
      const after = accountEmail(await request('account/read', { refreshToken: false }))
      if (before !== after) throw new CodexEnvironmentError('ACCOUNT_CHANGED')
      const scopeId = await identity.hashAccount(before, typeof rawAccountId === 'string' ? rawAccountId : undefined)
      if (!/^codex-[a-f0-9]{64}$/.test(scopeId)) throw new CodexEnvironmentError('INVALID_RESPONSE')
      finish(() => resolve(scopeId))
    } catch (error) {
      fail(error instanceof CodexEnvironmentError ? error.code : 'UNAVAILABLE')
    }
  })()
})

export async function checkCodexEnvironment(options: {
  identity: CodexScopeIdentity
  readOAuthSession?: () => Promise<ChatGptSessionResult>
  experimentalLocalAuth?: boolean
  signal?: AbortSignal
  timeoutMs?: number
  resolveExecutable?: typeof resolveCodexExecutable
  launch?: Launch
  now?: () => Date
}): Promise<CodexEnvironmentResult> {
  const controller = new AbortController()
  const checkedAt = () => (options.now?.() ?? new Date()).toISOString()
  const externalAbort = () => controller.abort('external')
  options.signal?.addEventListener('abort', externalAbort, { once: true })
  if (options.signal?.aborted) controller.abort('external')
  const timer = setTimeout(() => controller.abort('timeout'), options.timeoutMs ?? 15_000)
  let cliVersion: string | undefined
  try {
    if (controller.signal.aborted) throw new CodexEnvironmentError(options.signal?.aborted ? 'CANCELLED' : 'TIMEOUT')
    const resolved = await Promise.race([
      (options.resolveExecutable ?? resolveCodexExecutable)(),
      new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => {
        reject(new CodexEnvironmentError(options.signal?.aborted ? 'CANCELLED' : 'TIMEOUT'))
      }, { once: true })),
    ])
    cliVersion = await readVersion(resolved.executable, controller.signal, options.launch ?? defaultLaunch)
    if (!isSupportedCodexVersion(cliVersion)) {
      return { ok: false, code: 'VERSION_UNSUPPORTED', checkedAt: checkedAt(), cliVersion, minimumVersion: MINIMUM_CODEX_VERSION }
    }
    if (options.readOAuthSession) {
      const session = await options.readOAuthSession()
      if (session.ok && session.status === 'connected') {
        return {
          ok: true,
          checkedAt: checkedAt(),
          cliVersion,
          minimumVersion: MINIMUM_CODEX_VERSION,
          scopeId: session.scopeId,
          authMode: 'chatgpt-oauth',
        }
      }
      if (!options.experimentalLocalAuth) {
        const code: CodexEnvironmentErrorCode = session.ok
          ? 'AUTH_REQUIRED'
          : session.code === 'SCOPE_MISSING' || session.code === 'REAUTH_REQUIRED'
            || session.code === 'STORAGE_UNAVAILABLE' ? session.code : 'AUTH_REQUIRED'
        return { ok: false, code, checkedAt: checkedAt(), cliVersion, minimumVersion: MINIMUM_CODEX_VERSION }
      }
    }
    const scopeId = await readAccountScope(
      resolved.executable,
      controller.signal,
      options.identity,
      options.launch ?? defaultLaunch,
    )
    return {
      ok: true,
      checkedAt: checkedAt(),
      cliVersion,
      minimumVersion: MINIMUM_CODEX_VERSION,
      scopeId,
      authMode: 'local-codex-experimental',
    }
  } catch (error) {
    let code: CodexEnvironmentErrorCode = 'UNAVAILABLE'
    if (controller.signal.aborted) code = options.signal?.aborted ? 'CANCELLED' : 'TIMEOUT'
    else if (error instanceof CodexEnvironmentError) code = error.code
    else if (error instanceof CodexReadError && error.code === 'CLI_NOT_FOUND') code = 'CLI_NOT_FOUND'
    return { ok: false, code, checkedAt: checkedAt(), cliVersion, minimumVersion: MINIMUM_CODEX_VERSION }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', externalAbort)
  }
}
