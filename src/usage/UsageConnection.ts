import type { UsageProvider } from './UsageProvider'
import { UsageReader, type UsageReading } from './UsageReader'
import { startUsagePolling } from './usagePolling'

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
  start() {
    if (this.active) return
    this.active = true
    this.connect()
  }
  stop() {
    this.active = false
    ++this.generation
    this.polling?.stop()
    this.polling = null
  }
  select(source: UsageSource) {
    if (source === this.state.source) return
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
      this.publish({ source, reading, refreshing: false })
    })
  }
  async refresh(): Promise<UsageReading | null> {
    if (!this.polling) return null
    const generation = this.generation
    this.publish({ ...this.state, refreshing: true })
    await this.polling.refresh()
    return generation === this.generation ? this.state.reading : null
  }
}
