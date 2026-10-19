import type { UsageState } from '../types/usage'

export interface UsageProvider {
  getCurrentUsage(): Promise<UsageState>
}
