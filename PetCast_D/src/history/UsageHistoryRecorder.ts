import { validateHistorySample } from '../../electron/historySchema'
import type { UsageReading } from '../usage/UsageReader'
import type { UsageHistoryStore, UsageSample } from '../types/usageHistory'
/** Three-minute samples fit 90 days within the 100,000-record cap; boundaries are recorded immediately. */
export class UsageHistoryRecorder {
  private pending: Promise<unknown> = Promise.resolve()
  private seen = new Map<string, UsageSample>()
  private last = new Map<string, UsageSample>()
  constructor(private readonly store: UsageHistoryStore) {}
  record(reading: UsageReading | null): Promise<boolean> {
    if (reading?.status !== 'fresh') return Promise.resolve(false)
    const usage = reading.data
    if (reading.source === 'real' && !usage.scopeId) return Promise.reject(Error('真实历史缺少账号标识'))
    const sample: UsageSample = { id: `sample-${usage.sampledAt.getTime()}`, source: reading.source,
      scopeId: reading.source === 'mock' ? 'mock-local' : usage.scopeId!, sampledAt: usage.sampledAt.toISOString(),
      shortWindowRemaining: usage.shortWindowRemaining, weeklyRemaining: usage.weeklyRemaining,
      shortWindowResetAt: usage.shortWindowResetAt.toISOString(), weeklyResetAt: usage.weeklyResetAt.toISOString(), burnRate: usage.burnRate }
    const result = this.pending.then(async () => {
      validateHistorySample(sample)
      const key = `${sample.source}:${sample.scopeId}`, previous = this.last.get(key), seen = this.seen.get(key)
      const remember = () => { if (!seen || seen.sampledAt < sample.sampledAt) this.seen.set(key, sample) }
      if (previous) {
        const elapsed = Date.parse(sample.sampledAt) - Date.parse(previous.sampledAt)
        if (elapsed <= 0) return false
        const recovery = seen && seen.sampledAt < sample.sampledAt && (sample.shortWindowRemaining > seen.shortWindowRemaining || sample.weeklyRemaining > seen.weeklyRemaining)
        const boundary = recovery || sample.shortWindowResetAt !== previous.shortWindowResetAt || sample.weeklyResetAt !== previous.weeklyResetAt
          || sample.shortWindowRemaining > previous.shortWindowRemaining || sample.weeklyRemaining > previous.weeklyRemaining
          || (sample.shortWindowRemaining <= 25) !== (previous.shortWindowRemaining <= 25)
          || (sample.weeklyRemaining <= 22) !== (previous.weeklyRemaining <= 22)
        if (elapsed < 180_000 && !boundary) { remember(); return false }
        if (recovery && seen.sampledAt > previous.sampledAt) await this.store.appendUsageSample(seen)
      }
      await this.store.appendUsageSample(sample)
      this.last.set(key, sample)
      remember()
      return true
    })
    this.pending = result.catch(() => undefined)
    return result
  }
  /** Clearing a scope also allows the next fresh sample to start a new history. */
  async clear(scope: {source: UsageSample['source']; scopeId: string}) {
    const operation = this.pending.then(async () => {
      await this.store.clearUsageHistory(scope)
      this.last.delete(`${scope.source}:${scope.scopeId}`)
      this.seen.delete(`${scope.source}:${scope.scopeId}`)
    })
    this.pending = operation.catch(() => undefined)
    await operation
  }
}
