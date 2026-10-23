import type { UsageProvider } from './UsageProvider'
import { UsageReader, type UsageReading } from './UsageReader'
import { startUsagePolling } from './usagePolling'
import { cloneUsage } from './usageSnapshot'

export const MAX_FRESH_AGE_MS = 90_000

export type UsageSource = UsageProvider['source']
export interface UsageConnectionState {
  source: UsageSource
  reading: UsageReading | null
  refreshing: boolean
}

/** Own the UI session so late results cannot cross a source change or an unmount. */
export class UsageConnection {
  private state: UsageConnectionState
  private listeners = new Set<() => void>()
  private polling: ReturnType<typeof startUsagePolling> | null = null
  private active = false
  private generation = 0
  private freshnessTimer?: ReturnType<typeof setTimeout>
  constructor(private readonly makeProvider: (source: UsageSource) => UsageProvider, source: UsageSource = 'real') {
    this.state = { source, reading: null, refreshing: false }
  }
  getSnapshot = () => this.state
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private publish(state: UsageConnectionState) {
    this.state = state
    for (const listener of this.listeners) listener()
  }
  private withFreshness(reading: UsageReading): UsageReading {
    if (reading.status !== 'fresh') return reading
    const age = Date.now() - +reading.data.sampledAt
    if (age < 0 || age >= MAX_FRESH_AGE_MS) {
      return { ...reading, status: 'stale',
        data: { ...cloneUsage(reading.data), recentResetType: null },
        error: '额度已超过有效刷新间隔或系统时间发生变化，请重新读取。' }
    }
    return reading
  }
  private expireReading = () => {
    if (!this.active || !this.state.reading) return
    const reading = this.withFreshness(this.state.reading)
    if (reading !== this.state.reading) this.publish({ ...this.state, reading })
  }
  private armFreshnessTimer() {
    clearTimeout(this.freshnessTimer)
    const reading = this.state.reading
    if (reading?.status !== 'fresh') return
    const age = Date.now() - +reading.data.sampledAt
    if (age < 0 || age >= MAX_FRESH_AGE_MS) { this.expireReading(); return }
    this.freshnessTimer = setTimeout(this.expireReading, MAX_FRESH_AGE_MS - age)
  }
  start() {
    if (this.active) return
    this.active = true
    this.connect()
  }
  stop() {
    this.active = false
    clearTimeout(this.freshnessTimer)
    ++this.generation
    this.polling?.stop()
    this.polling = null
  }
  select(source: UsageSource) {
    if (source === this.state.source) return
    clearTimeout(this.freshnessTimer)
    ++this.generation
    this.polling?.stop()
    this.polling = null
    this.publish({ source, reading: null, refreshing: this.active })
    if (this.active) this.connect()
  }
  private connect() {
    const generation = ++this.generation
    const source = this.state.source
    // Every source switch gets a new Reader and a new real Provider.
    const reader = new UsageReader(this.makeProvider(source), 20_000)
    this.publish({ source, reading: null, refreshing: true })
    this.polling = startUsagePolling(reader, reading => {
      if (!this.active || generation !== this.generation) return
      this.publish({ source, reading: this.withFreshness(reading), refreshing: false })
      this.armFreshnessTimer()
    }, 30_000, this.expireReading)
  }
  async refresh(): Promise<UsageReading | null> {
    if (!this.polling) return null
    this.expireReading()
    const generation = this.generation
    this.publish({ ...this.state, refreshing: true })
    await this.polling.refresh()
    return generation === this.generation ? this.state.reading : null
  }
}
