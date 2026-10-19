import type { FishCatch, FishSpecies } from './fishing'

export type FishDisposition = 'kept' | 'fed' | 'released'

export interface KeptFish extends FishCatch {
  disposition: 'kept'
}

export interface CodexEntry {
  speciesId: FishSpecies['id']
  discovered: boolean
  firstCaughtAt?: string
  caughtCount: number
  fedCount: number
  releasedCount: number
  largestLength?: number
  smallestLength?: number
}

export type CodexState = Record<FishSpecies['id'], CodexEntry>
