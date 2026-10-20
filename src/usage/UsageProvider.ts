import type { UsageState } from '../types/usage'

export interface UsageProvider {
  readonly source: 'real' | 'mock'
  /** Return a complete validated snapshot; reject when required fields are unavailable. */
  getCurrentUsage(signal?: AbortSignal): Promise<UsageState>
}

