import type { UsageScenarioId, UsageState } from '../types/usage'
import type { UsageProvider } from './UsageProvider'

const addMinutes = (date: Date, minutes: number) => new Date(date.getTime() + minutes * 60_000)
const addHours = (date: Date, hours: number) => addMinutes(date, hours * 60)
const addDays = (date: Date, days: number) => addHours(date, days * 24)

export const createMockUsageState = (
  scenario: UsageScenarioId = 'balanced',
  now = new Date(),
): UsageState => {
  const shared = {
    sampledAt: now,
    recentResetType: null,
    baselineBurnRate: 5.2,
  } satisfies Partial<UsageState>

  const scenarios: Record<UsageScenarioId, UsageState> = {
    balanced: {
      ...shared,
      shortWindowRemaining: 68,
      weeklyRemaining: 62,
      shortWindowResetAt: addHours(now, 2.25),
      weeklyResetAt: addDays(now, 4.1),
      burnRate: 5.4,
    },
    shortPressure: {
      ...shared,
      shortWindowRemaining: 17,
      weeklyRemaining: 56,
      shortWindowResetAt: addMinutes(now, 52),
      weeklyResetAt: addDays(now, 3.8),
      burnRate: 13.8,
    },
    weeklyPressure: {
      ...shared,
      shortWindowRemaining: 71,
      weeklyRemaining: 13,
      shortWindowResetAt: addHours(now, 3.1),
      weeklyResetAt: addDays(now, 2.7),
      burnRate: 6.8,
    },
    resetSoon: {
      ...shared,
      shortWindowRemaining: 82,
      weeklyRemaining: 48,
      shortWindowResetAt: addMinutes(now, 22),
      weeklyResetAt: addDays(now, 3.2),
      burnRate: 2.2,
    },
    burst: {
      ...shared,
      shortWindowRemaining: 43,
      weeklyRemaining: 45,
      shortWindowResetAt: addHours(now, 1.8),
      weeklyResetAt: addDays(now, 3.4),
      burnRate: 17.5,
    },
    freshReset: {
      ...shared,
      shortWindowRemaining: 99,
      weeklyRemaining: 66,
      shortWindowResetAt: addHours(now, 4.95),
      weeklyResetAt: addDays(now, 4.4),
      burnRate: 1.2,
      recentResetType: 'short',
    },
  }

  return scenarios[scenario]
}

export class MockUsageProvider implements UsageProvider {
  readonly source = 'mock' as const
  private state: UsageState

  constructor(scenario: UsageScenarioId = 'balanced') {
    this.state = createMockUsageState(scenario)
  }

  async getCurrentUsage(): Promise<UsageState> {
    const now = new Date()
    const shortResetReached = this.state.shortWindowResetAt.getTime() <= now.getTime()
    const weeklyResetReached = this.state.weeklyResetAt.getTime() <= now.getTime()

    if (shortResetReached || weeklyResetReached) {
      const advancePastNow = (date: Date, intervalMs: number) => {
        const elapsedIntervals = Math.floor((now.getTime() - date.getTime()) / intervalMs) + 1
        return new Date(date.getTime() + elapsedIntervals * intervalMs)
      }
      this.state = {
        ...this.state,
        shortWindowRemaining: shortResetReached ? 100 : this.state.shortWindowRemaining,
        weeklyRemaining: weeklyResetReached ? 100 : this.state.weeklyRemaining,
        shortWindowResetAt: shortResetReached
          ? advancePastNow(this.state.shortWindowResetAt, 5 * 60 * 60_000)
          : this.state.shortWindowResetAt,
        weeklyResetAt: weeklyResetReached
          ? advancePastNow(this.state.weeklyResetAt, 7 * 24 * 60 * 60_000)
          : this.state.weeklyResetAt,
        burnRate: 0,
        recentResetType: weeklyResetReached ? 'weekly' : 'short',
      }
    }

    const snapshot = { ...this.state, sampledAt: now }
    if (this.state.recentResetType) this.state = { ...this.state, recentResetType: null }
    return snapshot
  }

  setScenario(scenario: UsageScenarioId) {
    this.state = createMockUsageState(scenario)
  }

  update(patch: Partial<UsageState>) {
    this.state = { ...this.state, ...patch, sampledAt: new Date(), recentResetType: null }
  }
}

