import { createEmptyCodex } from '../game/collection'
import { FISH_SPECIES } from '../game/fishSpecies'
import type { CodexState, KeptFish } from '../types/collection'
import type { MailItem } from '../types/notifications'
import type { GameSaveV1 } from '../types/persistence'
import type { UsageState } from '../types/usage'

const STORAGE_KEY = 'petcast.game-save.v1'
const fishIds: ReadonlySet<string> = new Set(FISH_SPECIES.map((species) => species.id))

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

const finiteNumber = (value: unknown, fallback: number) => (
  typeof value === 'number' && Number.isFinite(value) ? value : fallback
)

const validDate = (value: unknown, fallback: Date) => {
  if (typeof value !== 'string') return fallback
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? fallback : date
}

const restoreCodex = (value: unknown): CodexState => {
  const empty = createEmptyCodex()
  if (!isRecord(value)) return empty
  for (const species of FISH_SPECIES) {
    const saved = value[species.id]
    if (!isRecord(saved)) continue
    empty[species.id] = {
      ...empty[species.id],
      discovered: Boolean(saved.discovered),
      firstCaughtAt: typeof saved.firstCaughtAt === 'string' ? saved.firstCaughtAt : undefined,
      caughtCount: Math.max(0, finiteNumber(saved.caughtCount, 0)),
      fedCount: Math.max(0, finiteNumber(saved.fedCount, 0)),
      releasedCount: Math.max(0, finiteNumber(saved.releasedCount, 0)),
      largestLength: typeof saved.largestLength === 'number' ? saved.largestLength : undefined,
      smallestLength: typeof saved.smallestLength === 'number' ? saved.smallestLength : undefined,
    }
  }
  return empty
}

const restoreAquarium = (value: unknown): KeptFish[] => {
  if (!Array.isArray(value)) return []
  return value.flatMap((candidate) => {
    if (!isRecord(candidate) || typeof candidate.id !== 'string' || !isRecord(candidate.species)) return []
    const speciesId = candidate.species.id
    if (typeof speciesId !== 'string' || !fishIds.has(speciesId)) return []
    const species = FISH_SPECIES.find((item) => item.id === speciesId)
    if (!species) return []
    const snapshot = isRecord(candidate.usageSnapshot) ? candidate.usageSnapshot : {}
    const pattern = ['balanced', 'burst', 'night', 'resetRush'].includes(String(snapshot.pattern))
      ? snapshot.pattern as KeptFish['usageSnapshot']['pattern']
      : 'balanced'
    return [{
      ...candidate,
      species,
      disposition: 'kept' as const,
      length: finiteNumber(candidate.length, species.minLength),
      caughtAt: typeof candidate.caughtAt === 'string' ? candidate.caughtAt : new Date().toISOString(),
      usageSnapshot: {
        shortWindowRemaining: finiteNumber(snapshot.shortWindowRemaining, 50),
        weeklyRemaining: finiteNumber(snapshot.weeklyRemaining, 50),
        burnRate: finiteNumber(snapshot.burnRate, 5),
        pattern,
      },
    } as KeptFish]
  }).slice(0, 4)
}

const restoreMail = (value: unknown): MailItem[] => {
  if (!Array.isArray(value)) return []
  return value.flatMap((candidate): MailItem[] => {
    if (!isRecord(candidate) || typeof candidate.id !== 'string') return []
    if (candidate.type === 'resetSignal') {
      if (
        typeof candidate.author !== 'string'
        || typeof candidate.handle !== 'string'
        || typeof candidate.text !== 'string'
        || typeof candidate.publishedAt !== 'string'
        || !['short', 'weekly'].includes(String(candidate.resetType))
        || !['possible', 'likely'].includes(String(candidate.confidence))
        || typeof candidate.sourceLabel !== 'string'
        || typeof candidate.sourceUrl !== 'string'
      ) return []
      return [candidate as unknown as MailItem]
    }
    if (candidate.type === 'resetCompleted') {
      if (typeof candidate.createdAt !== 'string' || !['short', 'weekly'].includes(String(candidate.resetType))) return []
      return [candidate as unknown as MailItem]
    }
    if (candidate.type === 'autoFishing') {
      if (typeof candidate.createdAt !== 'string' || !Array.isArray(candidate.fish) || !Array.isArray(candidate.newSpeciesIds)) return []
      const fish = candidate.fish.filter((item) => (
        isRecord(item)
        && typeof item.speciesId === 'string'
        && fishIds.has(item.speciesId)
        && typeof item.name === 'string'
        && typeof item.length === 'number'
      ))
      const newSpeciesIds = candidate.newSpeciesIds.filter((id) => typeof id === 'string' && fishIds.has(id))
      return [{ ...candidate, fish, newSpeciesIds } as unknown as MailItem]
    }
    return []
  }).slice(0, 30)
}

export const createGameSave = (input: {
  aquarium: KeptFish[]
  codex: CodexState
  mailItems: MailItem[]
  unreadMailIds: string[]
  autoFishingEnabled: boolean
  resetWatchEnabled: boolean
  usage: UsageState
}): GameSaveV1 => ({
  version: 1,
  savedAt: new Date().toISOString(),
  aquarium: input.aquarium,
  codex: input.codex,
  mailItems: input.mailItems,
  unreadMailIds: input.unreadMailIds,
  autoFishingEnabled: input.autoFishingEnabled,
  resetWatchEnabled: input.resetWatchEnabled,
  usage: {
    shortWindowRemaining: input.usage.shortWindowRemaining,
    weeklyRemaining: input.usage.weeklyRemaining,
    shortWindowResetAt: input.usage.shortWindowResetAt.toISOString(),
    weeklyResetAt: input.usage.weeklyResetAt.toISOString(),
    burnRate: input.usage.burnRate,
    baselineBurnRate: input.usage.baselineBurnRate,
    sampledAt: input.usage.sampledAt.toISOString(),
  },
})

export const restoreGameSave = (value: unknown, fallbackUsage: UsageState): {
  save: GameSaveV1
  usage: UsageState
} | null => {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.usage)) return null
  const mailItems = restoreMail(value.mailItems)
  const mailIds = new Set(mailItems.map((item) => item.id))
  const usage: UsageState = {
    shortWindowRemaining: Math.min(100, Math.max(0, finiteNumber(value.usage.shortWindowRemaining, fallbackUsage.shortWindowRemaining))),
    weeklyRemaining: Math.min(100, Math.max(0, finiteNumber(value.usage.weeklyRemaining, fallbackUsage.weeklyRemaining))),
    shortWindowResetAt: validDate(value.usage.shortWindowResetAt, fallbackUsage.shortWindowResetAt),
    weeklyResetAt: validDate(value.usage.weeklyResetAt, fallbackUsage.weeklyResetAt),
    burnRate: Math.max(0, finiteNumber(value.usage.burnRate, fallbackUsage.burnRate)),
    baselineBurnRate: Math.max(0, finiteNumber(value.usage.baselineBurnRate, fallbackUsage.baselineBurnRate)),
    sampledAt: validDate(value.usage.sampledAt, new Date()),
    recentResetType: null,
  }
  return {
    usage,
    save: {
      version: 1,
      savedAt: typeof value.savedAt === 'string' ? value.savedAt : new Date().toISOString(),
      aquarium: restoreAquarium(value.aquarium),
      codex: restoreCodex(value.codex),
      mailItems,
      unreadMailIds: Array.isArray(value.unreadMailIds)
        ? value.unreadMailIds.filter((id): id is string => typeof id === 'string' && mailIds.has(id))
        : [],
      autoFishingEnabled: Boolean(value.autoFishingEnabled),
      resetWatchEnabled: value.resetWatchEnabled !== false,
      usage: {
        shortWindowRemaining: usage.shortWindowRemaining,
        weeklyRemaining: usage.weeklyRemaining,
        shortWindowResetAt: usage.shortWindowResetAt.toISOString(),
        weeklyResetAt: usage.weeklyResetAt.toISOString(),
        burnRate: usage.burnRate,
        baselineBurnRate: usage.baselineBurnRate,
        sampledAt: usage.sampledAt.toISOString(),
      },
    },
  }
}

export const loadGameSave = async (): Promise<unknown | null> => {
  if (window.petcast?.loadGameSave) return window.petcast.loadGameSave()
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    window.localStorage.removeItem(STORAGE_KEY)
    return null
  }
}

export const saveGame = async (save: GameSaveV1): Promise<void> => {
  if (window.petcast?.saveGame) {
    await window.petcast.saveGame(save)
    return
  }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(save))
}
