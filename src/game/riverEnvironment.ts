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
  waterTopPercent: number
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

  // High weekly allowance creates a fuller river; low allowance exposes more riverbank.
  const waterTopPercent = clamp(68 - usage.weeklyRemaining * 0.22, 46, 68)

  return {
    dayPhase,
    dayLabel,
    flow,
    flowLabel,
    flowDurationSeconds,
    depth,
    depthLabel,
    waterTopPercent,
  }
}
