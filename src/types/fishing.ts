import type { UsageState } from './usage'

export type FishingPattern = 'balanced' | 'burst' | 'night' | 'resetRush'

export type FishDifficulty = 'easy' | 'medium' | 'hard'

export interface FishSpecies {
  id: 'balanced-koi' | 'deadline-eel' | 'moonfin' | 'reset-salmon'
  name: string
  description: string
  pattern: FishingPattern
  difficulty: FishDifficulty
  reactionWindowMs: number
  minLength: number
  maxLength: number
  bodyColor: string
  accentColor: string
}

export interface FishingPatternResult {
  primary: FishingPattern
  tags: FishingPattern[]
  label: string
}

export interface FishCatch {
  id: string
  species: FishSpecies
  length: number
  caughtAt: string
  usageSnapshot: Pick<UsageState, 'shortWindowRemaining' | 'weeklyRemaining' | 'burnRate'> & {
    pattern: FishingPattern
  }
}
