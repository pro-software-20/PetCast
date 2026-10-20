import type { UsageState } from '../types/usage'

/** Dates are mutable: a spread alone must not connect UI objects to private history/cache. */
export function cloneUsage(value: UsageState): UsageState {
  return {
    ...value,
    sampledAt: new Date(value.sampledAt.getTime()),
    shortWindowResetAt: new Date(value.shortWindowResetAt.getTime()),
    weeklyResetAt: new Date(value.weeklyResetAt.getTime()),
  }
}
