import type { CodexState, KeptFish } from './collection'
import type { MailItem } from './notifications'

export interface PersistedUsageState {
  shortWindowRemaining: number
  weeklyRemaining: number
  shortWindowResetAt: string
  weeklyResetAt: string
  burnRate: number | null
  baselineBurnRate: number | null
  sampledAt: string
}

export interface GameSaveV1 {
  version: 1
  savedAt: string
  aquarium: KeptFish[]
  codex: CodexState
  mailItems: MailItem[]
  unreadMailIds: string[]
  autoFishingEnabled: boolean
  resetWatchEnabled: boolean
  usage: PersistedUsageState
}
