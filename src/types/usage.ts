export type RecentResetType = 'short' | 'weekly' | null

export interface UsageState {
  shortWindowRemaining: number
  weeklyRemaining: number
  shortWindowResetAt: Date
  weeklyResetAt: Date
  burnRate: number
  baselineBurnRate: number
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
