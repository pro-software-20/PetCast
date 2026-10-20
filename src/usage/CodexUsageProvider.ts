import { CODEX_USAGE_MESSAGES, type CodexQuotaResult, type CodexUsageErrorCode } from '../../electron/codexProtocol'
import type { UsageState } from '../types/usage'
import type { UsageProvider } from './UsageProvider'
import { cloneUsage } from './usageSnapshot'

export interface CodexUsageBridge {
  readCodexUsage(requestId: string): Promise<CodexQuotaResult>
  cancelCodexUsage(requestId: string): void
}
export class CodexUsageError extends Error {
  constructor(readonly code: CodexUsageErrorCode) { super(CODEX_USAGE_MESSAGES[code]) }
}
const validScope = (scope: unknown): scope is string => typeof scope === 'string' && /^codex-[a-f0-9]{64}$/.test(scope)
const date = (value: unknown) => {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT.*Z$/.test(value)) throw new CodexUsageError('INVALID_RESPONSE')
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new CodexUsageError('INVALID_RESPONSE')
  return parsed
}
const quota = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) throw new CodexUsageError('INVALID_RESPONSE')
  return value
}

/** No browser fetch, credential access, fallback data or internal polling. */
export class CodexUsageProvider implements UsageProvider {
  readonly source = 'real' as const
  private previous: UsageState | null = null
  private scope = 'unverified'
  private consumed = 0
  private coveredMs = 0
  private pending: Promise<UsageState> | null = null
  private activeSignal?: AbortSignal
  private generation = 0
  get cacheKey() { return this.previous?.scopeId ?? this.scope }
  constructor(private readonly bridge?: CodexUsageBridge) {}

  getCurrentUsage(signal?: AbortSignal): Promise<UsageState> {
    // UsageReader deduplicates. Direct overlapping callers must not share cancellation ownership.
    if (this.pending && !this.activeSignal?.aborted) return Promise.reject(new CodexUsageError('UNAVAILABLE'))
    this.activeSignal = signal
    const pending = this.read(++this.generation, signal).finally(() => {
      if (this.pending === pending) {
        this.pending = null
        this.activeSignal = undefined
      }
    })
    this.pending = pending
    return pending
  }
  private changeScope(scope: string) {
    if (scope === this.scope) return
    this.scope = scope
    this.previous = null
    this.consumed = 0
    this.coveredMs = 0
  }
  private checkAccountScope(accountScope: unknown) {
    if (accountScope !== undefined && !validScope(accountScope)) throw new CodexUsageError('INVALID_RESPONSE')
    const effectiveScope = accountScope ?? this.scope
    if (this.previous && this.previous.scopeId !== effectiveScope) {
      this.previous = null
      this.consumed = 0
      this.coveredMs = 0
    }
    return effectiveScope as string
  }
  private async read(generation: number, signal?: AbortSignal): Promise<UsageState> {
    const requestId = globalThis.crypto.randomUUID()
    let abort: (() => void) | undefined
    try {
      if (!this.bridge) throw new CodexUsageError('CLI_NOT_FOUND')
      if (signal?.aborted) throw new CodexUsageError('CANCELLED')
      const cancelled = new Promise<never>((_, reject) => {
        abort = () => {
          if (generation === this.generation) this.changeScope(`unverified-${requestId}`)
          try { this.bridge!.cancelCodexUsage(requestId) } catch { /* Still cancel locally. */ }
          reject(new CodexUsageError('CANCELLED'))
        }
        signal?.addEventListener('abort', abort, { once: true })
      })
      const result = await Promise.race([this.bridge.readCodexUsage(requestId), cancelled])
      if (signal?.aborted || generation !== this.generation) throw new CodexUsageError('CANCELLED')
      if (!result || typeof result !== 'object') throw new CodexUsageError('INVALID_RESPONSE')
      if (!result.ok) {
        if (validScope(result.scopeId)) this.changeScope(result.scopeId)
        else this.changeScope(`unverified-${requestId}`)
        if (result.accountScopeId !== undefined) this.checkAccountScope(result.accountScopeId)
        // Only transient failures with verified identity may reuse the last real snapshot.
        if (!['TIMEOUT', 'UNAVAILABLE'].includes(result.code)) this.changeScope(`unverified-${requestId}`)
        const code = Object.hasOwn(CODEX_USAGE_MESSAGES, result.code) ? result.code : 'UNAVAILABLE'
        throw new CodexUsageError(code)
      }
      const raw = result.snapshot
      if (!raw || !validScope(raw.scopeId)) throw new CodexUsageError('INVALID_RESPONSE')
      this.changeScope(raw.scopeId)
      const accountScope = this.checkAccountScope(raw.accountScopeId)
      const current: UsageState = {
        scopeId: accountScope,
        shortWindowRemaining: quota(raw.shortWindowRemaining),
        weeklyRemaining: quota(raw.weeklyRemaining),
        shortWindowResetAt: date(raw.shortWindowResetAt),
        weeklyResetAt: date(raw.weeklyResetAt),
        sampledAt: date(raw.sampledAt),
        burnRate: null, baselineBurnRate: null, recentResetType: null,
      }
      const previous = this.previous
      if (previous) {
        const elapsed = current.sampledAt.getTime() - previous.sampledAt.getTime()
        if (elapsed <= 0) throw new CodexUsageError('INVALID_RESPONSE')
        const sameWindow = +current.shortWindowResetAt === +previous.shortWindowResetAt
        const drop = previous.shortWindowRemaining - current.shortWindowRemaining
        if (elapsed <= 300_000 && sameWindow && drop >= 0) {
          current.burnRate = drop / (elapsed / 3_600_000)
          // Baseline excludes the current interval. First measured interval has no baseline.
          current.baselineBurnRate = this.coveredMs ? this.consumed / (this.coveredMs / 3_600_000) : null
          this.consumed += drop
          this.coveredMs += elapsed
        } else {
          this.consumed = 0
          this.coveredMs = 0
        }
        const advanced = (oldReset: Date, newReset: Date, oldRemaining: number, newRemaining: number) =>
          +newReset > +oldReset && +oldReset <= +current.sampledAt && newRemaining > oldRemaining
        if (advanced(previous.weeklyResetAt, current.weeklyResetAt, previous.weeklyRemaining, current.weeklyRemaining)) current.recentResetType = 'weekly'
        else if (advanced(previous.shortWindowResetAt, current.shortWindowResetAt, previous.shortWindowRemaining, current.shortWindowRemaining)) current.recentResetType = 'short'
      }
      this.previous = { ...cloneUsage(current), recentResetType: null }
      return current
    } catch (error) {
      if (generation === this.generation
        && (!(error instanceof CodexUsageError) || !['UNAVAILABLE', 'TIMEOUT'].includes(error.code))) {
        this.changeScope(`unverified-${requestId}`)
      }
      if (error instanceof CodexUsageError) throw error
      throw new CodexUsageError('UNAVAILABLE')
    } finally {
      if (abort) signal?.removeEventListener('abort', abort)
    }
  }
}
