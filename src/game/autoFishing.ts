import type { CodexState } from '../types/collection'
import type { FishCatch, FishSpecies } from '../types/fishing'
import type { UsageState } from '../types/usage'
import { recordCatch, recordDisposition } from './collection'
import { generateFish, type RandomSource } from './fishingEngine'

export interface AutoFishingRound {
  catches: FishCatch[]
  nextCodex: CodexState
  newSpeciesIds: FishSpecies['id'][]
}

export const generateAutoFishingRound = (
  usage: UsageState,
  codex: CodexState,
  count = 3,
  random: RandomSource = Math.random,
  now = new Date(),
): AutoFishingRound => {
  const catches = Array.from({ length: count }, (_, index) => (
    generateFish(usage, random, new Date(now.getTime() + index))
  ))
  const newSpeciesIds = [...new Set(catches
    .filter((fish) => !codex[fish.species.id].discovered)
    .map((fish) => fish.species.id))]
  const nextCodex = catches.reduce((state, fish) => (
    recordDisposition(recordCatch(state, fish), fish.species.id, 'released')
  ), codex)

  return { catches, nextCodex, newSpeciesIds }
}

