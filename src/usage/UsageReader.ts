import type { UsageState } from '../types/usage'
import type { UsageProvider } from './UsageProvider'
import { CODEX_USAGE_MESSAGES, type CodexUsageErrorCode } from '../../electron/codexProtocol'
import { cloneUsage } from './usageSnapshot'

export type UsageReading = {
  source: UsageProvider['source']
  checkedAt: Date
} & (
  | { status: 'fresh'; data: UsageState; error: null }
  | { status: 'stale'; data: UsageState; error: string }
  | { status: 'unavailable'; data: null; error: string }
)

export function validateUsage(value: UsageState): void {
  for (const quota of [value.shortWindowRemaining, value.weeklyRemaining]) {
    if (!Number.isFinite(quota) || quota < 0 || quota > 100) throw new Error('额度必须是 0–100 的有限数值')
  }
  for (const rate of [value.burnRate, value.baselineBurnRate]) {
    if (rate !== null && (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0)) throw new Error('消耗速度必须是非负有限数值或 null')
  }
  for (const date of [value.sampledAt, value.shortWindowResetAt, value.weeklyResetAt]) {
    if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new Error('额度时间无效')
  }
  if (![null, 'short', 'weekly'].includes(value.recentResetType)) throw new Error('重置类型无效')
}

/** One reader per source/account. Never substitute mock values after a real request fails. */
export class UsageReader {
  private pending: Promise<UsageReading> | null = null
  private lastGood: UsageState | null = null
  private lastScope: string | undefined
  private controller: AbortController | null = null
  constructor(private readonly provider: UsageProvider, private readonly timeoutMs = 10_000) {}

  read(): Promise<UsageReading> {
    if (this.pending && !this.controller?.signal.aborted) return this.pending
    const pending = this.fetch().finally(() => {
      if (this.pending === pending) this.pending = null
    })
    this.pending = pending
    return pending
  }

  cancel(): void { this.controller?.abort({ code: 'CANCELLED' }) }

  private async fetch(): Promise<UsageReading> {
    const controller = new AbortController()
    this.controller = controller
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    try {
      const interrupted = new Promise<never>((_, reject) => {
        onAbort = () => reject(controller.signal.reason)
        controller.signal.addEventListener('abort', onAbort, { once: true })
        timer = setTimeout(() => controller.abort({ code: 'TIMEOUT' }), this.timeoutMs)
      })
      const data = await Promise.race([this.provider.getCurrentUsage(controller.signal), interrupted])
      if (controller.signal.aborted) throw controller.signal.reason
      validateUsage(data)
      this.lastScope = this.provider.cacheKey
      this.lastGood = { ...cloneUsage(data), recentResetType: null }
      return { source: this.provider.source, checkedAt: new Date(), status: 'fresh', data: cloneUsage(data), error: null }
    } catch (error) {
      // Do not expose provider exception text: it may contain credentials or response bodies.
      const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
      const message = typeof code === 'string' && Object.hasOwn(CODEX_USAGE_MESSAGES, code)
        ? CODEX_USAGE_MESSAGES[code as CodexUsageErrorCode] : '额度读取失败，请稍后重试'
      const common = { source: this.provider.source, checkedAt: new Date(), error: message }
      // An obsolete request must never clear or replace the newer request's cache.
      if (this.controller !== controller || code === 'CANCELLED') {
        return { ...common, status: 'unavailable', data: null }
      }
      if (this.provider.cacheKey !== this.lastScope) this.lastGood = null
      return this.lastGood
        ? { ...common, status: 'stale', data: cloneUsage(this.lastGood) }
        : { ...common, status: 'unavailable', data: null }
    } finally {
      clearTimeout(timer)
      if (onAbort) controller.signal.removeEventListener('abort', onAbort)
      if (this.controller === controller) this.controller = null
    }
  }
}
