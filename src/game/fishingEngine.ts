import type { FishCatch, FishingPattern, FishingPatternResult } from '../types/fishing'
import type { UsageState } from '../types/usage'
import { FISH_SPECIES } from './fishSpecies'

export type RandomSource = () => number

const minutesUntil = (date: Date, now: Date) => (date.getTime() - now.getTime()) / 60_000

export const classifyFishingPattern = (
  usage: UsageState,
  now = new Date(),
): FishingPatternResult => {
  const tags: FishingPattern[] = []
  const hour = now.getHours()
  const resetMinutes = minutesUntil(usage.shortWindowResetAt, now)

  if (hour >= 22 || hour <= 4) tags.push('night')
  if (usage.burnRate !== null && usage.baselineBurnRate !== null
    && usage.burnRate >= Math.max(8, usage.baselineBurnRate * 1.55)) tags.push('burst')
  if (resetMinutes >= 0 && resetMinutes <= 45) tags.push('resetRush')
  if (!tags.length) tags.push('balanced')

  const primary = tags.includes('resetRush')
    ? 'resetRush'
    : tags.includes('burst')
      ? 'burst'
      : tags.includes('night')
        ? 'night'
        : 'balanced'

  const labels: Record<FishingPattern, string> = {
    balanced: '均衡水域',
    burst: '爆发急流',
    night: '月夜水域',
    resetRush: '重置潮汐',
  }

  return { primary, tags, label: labels[primary] }
}

export const generateFish = (
  usage: UsageState,
  random: RandomSource = Math.random,
  now = new Date(),
): FishCatch => {
  const pattern = classifyFishingPattern(usage, now)
  const weighted = FISH_SPECIES.map((species) => ({
    species,
    weight: pattern.tags.includes(species.pattern) ? 8 : 1,
  }))
  const totalWeight = weighted.reduce((sum, item) => sum + item.weight, 0)
  let cursor = random() * totalWeight
  const selected = weighted.find((item) => {
    cursor -= item.weight
    return cursor <= 0
  })?.species ?? weighted[weighted.length - 1].species
  const length = selected.minLength + random() * (selected.maxLength - selected.minLength)

  return {
    id: `${now.getTime()}-${Math.floor(random() * 1_000_000)}`,
    species: selected,
    length: Math.round(length * 10) / 10,
    caughtAt: now.toISOString(),
    usageSnapshot: {
      shortWindowRemaining: usage.shortWindowRemaining,
      weeklyRemaining: usage.weeklyRemaining,
      burnRate: usage.burnRate,
      pattern: pattern.primary,
    },
  }
}
