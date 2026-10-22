import type { UsageAnalysis, UsageFlag, UsageState } from '../types/usage'

const clamp = (value: number, min = 0, max = 100) => Math.min(max, Math.max(min, value))

const minutesUntil = (date: Date, now: Date) => Math.max(0, Math.ceil((date.getTime() - now.getTime()) / 60_000))

const proactiveFlags: ReadonlySet<UsageFlag> = new Set([
  'freshReset', 'shortLow', 'weeklyLow', 'shortResetSoon', 'weeklyResetSoon', 'accelerating', 'resetPending',
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

export const formatResetStatus = (date: Date, now = new Date()) => +date <= +now
  ? '已到预计时间，待确认' : `预计 ${formatTimeUntil(date, now)}后重置`

export const resetConfirmationMessage = (usage: UsageState) => {
  const restored = usage.recentResetType === 'weekly' ? '周额度' : '5h 额度'
  const balances = `当前 5h 剩余 ${usage.shortWindowRemaining}%，周剩余 ${usage.weeklyRemaining}%。`
  return `${restored}已观测到恢复。${balances}${usage.shortWindowRemaining <= 25 || usage.weeklyRemaining <= 22
    ? '仍有额度处于低位，请先核对任务所需资源。' : '执行任务前仍需核对所需额度和期限。'}`
}

export const analyzeUsage = (usage: UsageState, now = new Date()): UsageAnalysis => {
  const flags: UsageFlag[] = []
  const shortResetMinutes = minutesUntil(usage.shortWindowResetAt, now)
  const weeklyResetMinutes = minutesUntil(usage.weeklyResetAt, now)
  const resetPending = +usage.shortWindowResetAt <= +now || +usage.weeklyResetAt <= +now
  const expectedWeeklyRemaining = clamp((weeklyResetMinutes / (7 * 24 * 60)) * 100)
  const weeklyDelta = usage.weeklyRemaining - expectedWeeklyRemaining
  const weeklyPace = weeklyDelta < -10 ? 'fast' : weeklyDelta > 14 ? 'conservative' : 'balanced'
  const weeklyPaceLabel = weeklyPace === 'fast' ? '周节奏偏快' : weeklyPace === 'conservative' ? '周节奏偏保守' : '周节奏平稳'

  if (usage.recentResetType) flags.push('freshReset')
  if (usage.shortWindowRemaining <= 25) flags.push('shortLow')
  if (usage.weeklyRemaining <= 22) flags.push('weeklyLow')
  if (+usage.shortWindowResetAt > +now && shortResetMinutes <= 45) flags.push('shortResetSoon')
  if (+usage.weeklyResetAt > +now && weeklyResetMinutes <= 12 * 60) flags.push('weeklyResetSoon')
  if (resetPending) flags.push('resetPending')
  if (usage.burnRate !== null && usage.baselineBurnRate !== null
    && usage.burnRate > Math.max(8, usage.baselineBurnRate * 1.55)) flags.push('accelerating')
  if (usage.shortWindowRemaining >= 55 && usage.weeklyRemaining >= 35) flags.push('capacityAvailable')
  if (!flags.length || (weeklyPace === 'balanced' && !flags.some((flag) => ['freshReset', 'shortLow', 'weeklyLow', 'shortResetSoon', 'weeklyResetSoon', 'accelerating'].includes(flag)))) {
    flags.push('balanced')
  }

  let primary: UsageFlag = 'balanced'
  let petMood: UsageAnalysis['petMood'] = 'normal'
  let badge = '节奏平稳'
  let headline = '本周节奏稳定'
  let message = '现在的使用节奏很均衡，继续保持就好。'

  if (resetPending) {
    primary = 'resetPending'
    badge = '重置待确认'
    headline = '等待服务端更新'
    message = `已到预计重置时间，尚未确认新的额度窗口。当前读取为 5h 剩余 ${usage.shortWindowRemaining}%，周剩余 ${usage.weeklyRemaining}%；请重新读取后再安排任务。`
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
    message = shortResetMinutes <= 45 ? `5h 额度预计 ${formatTimeUntil(usage.shortWindowResetAt, now)}后重置，到时需重新读取确认。` : '短期剩余额度较少，可以先整理思路或处理不需要 AI 的工作。'
  } else if (flags.includes('weeklyLow')) {
    primary = 'weeklyLow'
    petMood = 'exhausted'
    badge = '周额度偏低'
    headline = '本周需要省一点'
    message = '周剩余额度处于低位，建议先核对重要任务所需资源。'
  } else if (flags.includes('shortLow')) {
    primary = 'shortLow'
    petMood = 'tired'
    badge = '5h 额度偏低'
    headline = '这轮用得有点快'
    message = '短期额度进入低位，可以稍微放慢节奏。'
  } else if (flags.includes('freshReset')) {
    primary = 'freshReset'
    petMood = 'celebrating'
    badge = '刚刚重置'
    headline = '额度恢复啦'
    message = resetConfirmationMessage(usage)
  } else if (flags.includes('shortResetSoon') && usage.shortWindowRemaining >= 60) {
    primary = 'shortResetSoon'
    petMood = 'anxious'
    badge = '5h 即将重置'
    headline = '这一轮还有余量'
    message = `当前剩余 ${usage.shortWindowRemaining}%，预计 ${formatTimeUntil(usage.shortWindowResetAt, now)}后重置，实际恢复需重新读取确认。`
  } else if (flags.includes('weeklyResetSoon') && usage.weeklyRemaining >= 35) {
    primary = 'weeklyResetSoon'
    petMood = 'anxious'
    badge = '周额度将重置'
    headline = '本周还有余量'
    message = `周额度预计 ${formatTimeUntil(usage.weeklyResetAt, now)}后重置，实际恢复需重新读取确认。`
  } else if (flags.includes('accelerating')) {
    primary = 'accelerating'
    petMood = 'anxious'
    badge = '消耗正在加快'
    headline = '最近用得明显更快'
    message = '最近一个采样区间的消耗速度高于本次连续观测的先前均值，可查看当前任务消耗；这不代表长期使用习惯。'
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
    headline = '两个窗口都有余量'
    message = '当前 5h 与周额度均有余量；是否执行任务还需结合任务规模、期限及实际消耗。'
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
    shortResetText: formatResetStatus(usage.shortWindowResetAt, now),
    weeklyResetText: formatResetStatus(usage.weeklyResetAt, now),
  }
}
