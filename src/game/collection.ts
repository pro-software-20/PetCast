import type { CodexState, FishDisposition, KeptFish } from '../types/collection'
import type { FishCatch, FishSpecies } from '../types/fishing'
import { FISH_SPECIES } from './fishSpecies'

export const AQUARIUM_CAPACITY = 4

export const createEmptyCodex = (): CodexState => Object.fromEntries(
  FISH_SPECIES.map((species) => [species.id, {
    speciesId: species.id,
    discovered: false,
    caughtCount: 0,
    fedCount: 0,
    releasedCount: 0,
  }]),
) as CodexState

export const recordCatch = (codex: CodexState, fish: FishCatch): CodexState => {
  const current = codex[fish.species.id]
  return {
    ...codex,
    [fish.species.id]: {
      ...current,
      discovered: true,
      firstCaughtAt: current.firstCaughtAt ?? fish.caughtAt,
      caughtCount: current.caughtCount + 1,
      largestLength: Math.max(current.largestLength ?? fish.length, fish.length),
      smallestLength: Math.min(current.smallestLength ?? fish.length, fish.length),
    },
  }
}

export const recordDisposition = (
  codex: CodexState,
  speciesId: FishSpecies['id'],
  disposition: Exclude<FishDisposition, 'kept'>,
): CodexState => {
  const current = codex[speciesId]
  return {
    ...codex,
    [speciesId]: {
      ...current,
      fedCount: current.fedCount + (disposition === 'fed' ? 1 : 0),
      releasedCount: current.releasedCount + (disposition === 'released' ? 1 : 0),
    },
  }
}

export const toKeptFish = (fish: FishCatch): KeptFish => ({ ...fish, disposition: 'kept' })

export const replaceAquariumFish = (
  aquarium: KeptFish[],
  incoming: FishCatch,
  outgoingId: string,
): KeptFish[] => aquarium.map((fish) => fish.id === outgoingId ? toKeptFish(incoming) : fish)
