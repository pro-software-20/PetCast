import type { UsageState } from '../types/usage'

export interface UsageProvider {
  /** Changes on account changes or lost identity verification; invalidates Reader cache. */
  readonly cacheKey?: string
  readonly source: 'real' | 'mock'
  /** Return a complete validated snapshot; reject when required fields are unavailable. */
  getCurrentUsage(signal?: AbortSignal): Promise<UsageState>
}

