import type { UsageState } from '../types/usage'
import type { UsageProvider } from './UsageProvider'

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
    if (!Number.isFinite(rate) || rate < 0) throw new Error('消耗速度必须是非负有限数值')
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
  constructor(private readonly provider: UsageProvider, private readonly timeoutMs = 10_000) {}

  read(): Promise<UsageReading> {
    if (this.pending) return this.pending
    this.pending = this.fetch().finally(() => { this.pending = null })
    return this.pending
  }

  private async fetch(): Promise<UsageReading> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('读取额度超时')) }, this.timeoutMs)
      })
      const data = await Promise.race([this.provider.getCurrentUsage(controller.signal), timeout])
      validateUsage(data)
      this.lastGood = { ...data, recentResetType: null }
      return { source: this.provider.source, checkedAt: new Date(), status: 'fresh', data, error: null }
    } catch {
      // Do not expose provider exception text: it may contain credentials or response bodies.
      const common = { source: this.provider.source, checkedAt: new Date(), error: '额度读取失败，请稍后重试' }
      return this.lastGood
        ? { ...common, status: 'stale', data: this.lastGood }
        : { ...common, status: 'unavailable', data: null }
    } finally {
      clearTimeout(timer)
    }
  }
}
