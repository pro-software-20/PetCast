/** UTC ISO 8601 dates. Rate unit: short-window percentage points per hour. */
export interface UsageSample {
  id: string
  source: 'real' | 'mock'
  /** Non-secret scope identifier; never a token, cookie or email address. */
  scopeId: string
  sampledAt: string
  shortWindowRemaining: number
  weeklyRemaining: number
  shortWindowResetAt: string
  weeklyResetAt: string
  burnRate: number | null
}

export interface UsageReport {
  startAt: string
  endAt: string
  timeZone: string
  source: UsageSample['source']
  scopeId: string
  sampleCount: number
  coverageMs: number
  averageBurnRate: number | null
  peakBurnRate: number | null
  activePeriods: string[]
  shortQuotaPressureCount: number
  weeklyQuotaPressureCount: number
  suggestions: string[]
  warnings: string[]
}

/** Implemented by independent desktop file storage and browser storage. */
export interface UsageHistoryStore {
  appendUsageSample(sample: UsageSample): Promise<void>
  queryUsageSamples(query: { startAt: string; endAt: string; source: UsageSample['source']; scopeId: string }): Promise<UsageSample[]>
  clearUsageHistory(scope: { source: UsageSample['source']; scopeId: string }): Promise<void>
}
