export type PetFacing = 'left' | 'right'
export const MIN_PET_TURN_MS = 18_000
export type PetHabitat = { kind: 'sand' | 'water'; minX: number; maxX: number; spawnX: number }
export function getPetHabitat(petId: string): PetHabitat {
  return ['cat', 'dog', 'chicken', 'rabbit'].includes(petId)
    ? { kind: 'sand', minX: 27, maxX: 50, spawnX: 35.5 }
    : { kind: 'water', minX: 29, maxX: 70, spawnX: 40 }
}
export interface PetRoamingState {
  habitat: PetHabitat
  phase: 'idle' | 'moving'
  facing: PetFacing
  x: number
  fromX: number
  targetX: number
  elapsedMs: number
  durationMs: number
  activeMs: number
  lastTurnMs: number
}
type Random = () => number
const between = (min: number, max: number, random: Random) => min + (max - min) * Math.max(0, Math.min(1, random()))
export function createPetRoaming(petId: string, random: Random = Math.random): PetRoamingState {
  const habitat = getPetHabitat(petId)
  return { habitat, phase: 'idle', facing: 'right', x: habitat.spawnX, fromX: habitat.spawnX, targetX: habitat.spawnX,
    elapsedMs: 0, durationMs: between(2800, 4500, random), activeMs: 0, lastTurnMs: 0 }
}
export function pausePetRoaming(state: PetRoamingState): PetRoamingState {
  return { ...state, phase: 'idle', fromX: state.x, targetX: state.x, elapsedMs: 0, durationMs: 3500 }
}
export function advancePetRoaming(state: PetRoamingState, deltaMs: number, random: Random = Math.random): PetRoamingState {
  if (!Number.isFinite(deltaMs) || deltaMs <= 0) return state
  const next = { ...state, elapsedMs: state.elapsedMs + deltaMs, activeMs: state.activeMs + deltaMs }
  if (next.phase === 'moving') {
    const t = Math.min(1, next.elapsedMs / next.durationMs)
    const eased = t * t * (3 - 2 * t)
    next.x = Math.max(next.habitat.minX, Math.min(next.habitat.maxX, next.fromX + (next.targetX - next.fromX) * eased))
    if (t === 1) {
      next.phase = 'idle'; next.elapsedMs = 0; next.durationMs = between(5000, 10_000, random)
      next.fromX = next.x; next.targetX = next.x
    }
    return next
  }
  if (next.elapsedMs < next.durationMs) return next
  const room = (facing: PetFacing) => facing === 'right' ? next.habitat.maxX - next.x : next.x - next.habitat.minX
  const canTurn = next.activeMs - next.lastTurnMs >= MIN_PET_TURN_MS
  const opposite: PetFacing = next.facing === 'right' ? 'left' : 'right'
  if (canTurn && (room(next.facing) < 6 || (room(opposite) >= 8 && random() < .3))) {
    next.facing = opposite; next.lastTurnMs = next.activeMs
  }
  if (room(next.facing) < 5) {
    next.elapsedMs = 0; next.durationMs = Math.max(1800, MIN_PET_TURN_MS - (next.activeMs - next.lastTurnMs))
    return next
  }
  const distance = Math.min(room(next.facing), between(8, 14, random))
  next.phase = 'moving'; next.fromX = next.x; next.targetX = next.x + (next.facing === 'right' ? distance : -distance)
  next.elapsedMs = 0; next.durationMs = Math.max(8500, distance / between(.85, 1.15, random) * 1000)
  return next
}
