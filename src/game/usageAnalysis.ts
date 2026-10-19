import type { UsageAnalysis, UsageFlag, UsageState } from '../types/usage'

const clamp = (value: number, min = 0, max = 100) => Math.min(max, Math.max(min, value))

const minutesUntil = (date: Date, now: Date) => Math.max(0, Math.round((date.getTime() - now.getTime()) / 60_000))

const proactiveFlags: ReadonlySet<UsageFlag> = new Set([
  'freshReset', 'shortLow', 'weeklyLow', 'shortResetSoon', 'weeklyResetSoon', 'accelerating',
])

export const isProactiveUsageFlag = (flag: UsageFlag) => proactiveFlags.has(flag)

export const formatTimeUntil = (date: Date, now = new Date()) => {
  const minutes = minutesUntil(date, now)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  if (hours < 24) return remainder ? `${hours} 小时 ${remainder} 分` : `${hours} 小时`
  const days = Math.floor(hours / 24)
  const dayHours = hours % 24
  return dayHours ? `${days} 天 ${dayHours} 小时` : `${days} 天`
}

export const analyzeUsage = (usage: UsageState, now = new Date()): UsageAnalysis => {
  const flags: UsageFlag[] = []
  const shortResetMinutes = minutesUntil(usage.shortWindowResetAt, now)
  const weeklyResetMinutes = minutesUntil(usage.weeklyResetAt, now)
  const expectedWeeklyRemaining = clamp((weeklyResetMinutes / (7 * 24 * 60)) * 100)
  const weeklyDelta = usage.weeklyRemaining - expectedWeeklyRemaining
  const weeklyPace = weeklyDelta < -10 ? 'fast' : weeklyDelta > 14 ? 'conservative' : 'balanced'
  const weeklyPaceLabel = weeklyPace === 'fast' ? '周节奏偏快' : weeklyPace === 'conservative' ? '周节奏偏保守' : '周节奏平稳'

  if (usage.recentResetType) flags.push('freshReset')
  if (usage.shortWindowRemaining <= 25) flags.push('shortLow')
  if (usage.weeklyRemaining <= 22) flags.push('weeklyLow')
  if (shortResetMinutes <= 45) flags.push('shortResetSoon')
  if (weeklyResetMinutes <= 12 * 60) flags.push('weeklyResetSoon')
  if (usage.burnRate > Math.max(8, usage.baselineBurnRate * 1.55)) flags.push('accelerating')
  if (usage.shortWindowRemaining >= 55 && usage.weeklyRemaining >= 35) flags.push('capacityAvailable')
  if (!flags.length || (weeklyPace === 'balanced' && !flags.some((flag) => ['freshReset', 'shortLow', 'weeklyLow', 'shortResetSoon', 'weeklyResetSoon', 'accelerating'].includes(flag)))) {
    flags.push('balanced')
  }

  let primary: UsageFlag = 'balanced'
  let petMood: UsageAnalysis['petMood'] = 'normal'
  let badge = '节奏平稳'
  let headline = '本周节奏稳定'
  let message = '现在的使用节奏很均衡，继续保持就好。'

  if (flags.includes('freshReset')) {
    primary = 'freshReset'
    petMood = 'celebrating'
    badge = '刚刚重置'
    headline = '额度恢复啦'
    message = usage.recentResetType === 'weekly' ? '周额度刚刚恢复，可以重新安排这一周。' : '5h 额度刚刚恢复，现在适合开始较大的任务。'
  } else if (usage.weeklyRemaining <= 8) {
    primary = 'weeklyLow'
    petMood = 'exhausted'
    badge = '周额度告急'
    headline = '先留给重要任务'
    message = '周额度已经很少，建议把剩余额度留给最重要的工作。'
  } else if (usage.shortWindowRemaining <= 10) {
    primary = 'shortLow'
    petMood = 'tired'
    badge = '5h 额度很低'
    headline = '这一轮快用完了'
    message = shortResetMinutes <= 45 ? `再过 ${formatTimeUntil(usage.shortWindowResetAt, now)}，5h 额度就会恢复。` : '这一轮消耗较快，可以先整理思路或处理不需要 AI 的工作。'
  } else if (flags.includes('weeklyLow')) {
    primary = 'weeklyLow'
    petMood = 'exhausted'
    badge = '周额度偏低'
    headline = '本周需要省一点'
    message = '当前周额度低于均衡进度，建议减少低优先级的大任务。'
  } else if (flags.includes('shortLow')) {
    primary = 'shortLow'
    petMood = 'tired'
    badge = '5h 额度偏低'
    headline = '这轮用得有点快'
    message = '短期额度进入低位，可以稍微放慢节奏。'
  } else if (flags.includes('shortResetSoon') && usage.shortWindowRemaining >= 60) {
    primary = 'shortResetSoon'
    petMood = 'anxious'
    badge = '5h 即将重置'
    headline = '这一轮还有余量'
    message = `还有 ${usage.shortWindowRemaining}% 未使用，${formatTimeUntil(usage.shortWindowResetAt, now)}后会重置。`
  } else if (flags.includes('weeklyResetSoon') && usage.weeklyRemaining >= 35) {
    primary = 'weeklyResetSoon'
    petMood = 'anxious'
    badge = '周额度将重置'
    headline = '本周还有余量'
    message = `周额度将在 ${formatTimeUntil(usage.weeklyResetAt, now)}后重置，可以安排必要任务。`
  } else if (flags.includes('accelerating')) {
    primary = 'accelerating'
    petMood = 'anxious'
    badge = '消耗正在加快'
    headline = '最近用得明显更快'
    message = '当前消耗速度高于平时，建议确认正在做的任务是否值得继续投入。'
  } else if (weeklyPace === 'fast') {
    primary = 'weeklyLow'
    petMood = 'tired'
    badge = '周节奏偏快'
    headline = '本周需要慢一点'
    message = '按当前进度，周额度可能会提前紧张，建议减少非必要尝试。'
  } else if (flags.includes('capacityAvailable')) {
    primary = 'capacityAvailable'
    petMood = 'happy'
    badge = '额度充足'
    headline = '适合安排较大任务'
    message = '5h 与周额度都比较健康，现在适合处理需要较多上下文的任务。'
  }

  return {
    primary,
    flags,
    petMood,
    badge,
    headline,
    message,
    weeklyPaceLabel,
    weeklyPace,
    expectedWeeklyRemaining: Math.round(expectedWeeklyRemaining),
    shortResetText: `${formatTimeUntil(usage.shortWindowResetAt, now)}后恢复`,
    weeklyResetText: `${formatTimeUntil(usage.weeklyResetAt, now)}后重置`,
  }
}
