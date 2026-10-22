export type RecentResetType = 'short' | 'weekly' | null

export interface UsageState {
  /** Local source verification; never persisted as report evidence or game save. */
  diagnostics?: import('../../electron/codexProtocol').CodexQuotaDiagnostics
  /** Non-sensitive local account scope; real providers always supply it. */
  scopeId?: string
  shortWindowRemaining: number
  weeklyRemaining: number
  shortWindowResetAt: Date
  weeklyResetAt: Date
  /** Short-window percentage points consumed per hour, never Token/hour. */
  burnRate: number | null
  /** Historical baseline in the same unit and scope as burnRate. */
  baselineBurnRate: number | null
  sampledAt: Date
  recentResetType: RecentResetType
}

export type UsageScenarioId =
  | 'balanced'
  | 'shortPressure'
  | 'weeklyPressure'
  | 'resetSoon'
  | 'burst'
  | 'freshReset'

export type PetMood =
  | 'happy'
  | 'normal'
  | 'tired'
  | 'anxious'
  | 'exhausted'
  | 'celebrating'

export type UsageFlag =
  | 'resetPending'
  | 'balanced'
  | 'capacityAvailable'
  | 'shortLow'
  | 'weeklyLow'
  | 'shortResetSoon'
  | 'weeklyResetSoon'
  | 'accelerating'
  | 'freshReset'

export interface UsageAnalysis {
  primary: UsageFlag
  flags: UsageFlag[]
  petMood: PetMood
  badge: string
  headline: string
  message: string
  weeklyPaceLabel: string
  weeklyPace: 'fast' | 'balanced' | 'conservative'
  expectedWeeklyRemaining: number
  shortResetText: string
  weeklyResetText: string
}

