import type { UsageState } from '../types/usage'

export type DayPhase = 'day' | 'twilight' | 'night'
export type RiverFlow = 'calm' | 'steady' | 'rapid'
export type RiverDepth = 'shallow' | 'normal' | 'deep'

export interface RiverEnvironment {
  dayPhase: DayPhase
  dayLabel: string
  flow: RiverFlow
  flowLabel: string
  flowDurationSeconds: number
  depth: RiverDepth
  depthLabel: string
  waterTier: 1 | 2 | 3 | 4
  waterTopPercent: number
  waterRecedePercent: number
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

export const deriveRiverEnvironment = (
  usage: UsageState,
  now = new Date(),
): RiverEnvironment => {
  const hour = now.getHours()
  const dayPhase: DayPhase = hour >= 20 || hour < 6
    ? 'night'
    : hour >= 18 || hour < 8
      ? 'twilight'
      : 'day'

  const dayLabel = dayPhase === 'night' ? '夜晚' : dayPhase === 'twilight' ? '晨昏' : '白天'
  const hasRate = usage.burnRate !== null && usage.baselineBurnRate !== null
  const rateRatio = hasRate ? usage.burnRate! / Math.max(usage.baselineBurnRate!, 0.5) : 1
  const flow: RiverFlow = rateRatio >= 1.55 ? 'rapid' : rateRatio <= 0.72 ? 'calm' : 'steady'
  const flowLabel = !hasRate ? '速度数据不足' : flow === 'rapid' ? '湍急' : flow === 'calm' ? '舒缓' : '平稳'
  const flowDurationSeconds = clamp(11.8 - rateRatio * 3.2, 3.4, 10.5)

  const depth: RiverDepth = usage.weeklyRemaining >= 65
    ? 'deep'
    : usage.weeklyRemaining <= 25
      ? 'shallow'
      : 'normal'
  const depthLabel = depth === 'deep' ? '丰沛' : depth === 'shallow' ? '浅水' : '正常'

  // Keep every level inside the illustrated river channel. The source artwork already
  // contains its shoreline, so lower tiers expose a small sand strip over that water.
  const waterTier: RiverEnvironment['waterTier'] = usage.weeklyRemaining < 25
    ? 1
    : usage.weeklyRemaining < 50
      ? 2
      : usage.weeklyRemaining < 75
        ? 3
        : 4
  const waterTopPercent = [84, 81, 78, 75.5][waterTier - 1]
  const waterRecedePercent = [9, 6, 3, 0][waterTier - 1]

  return {
    dayPhase,
    dayLabel,
    flow,
    flowLabel,
    flowDurationSeconds,
    depth,
    depthLabel,
    waterTier,
    waterTopPercent,
    waterRecedePercent,
  }
}
