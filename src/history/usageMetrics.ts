import type { UsageReport, UsageSample } from '../types/usageHistory'
import { sameScope, validateHistoryQuery, validateHistorySample } from '../../electron/historySchema'
export interface DailyUsage { date: string; consumedPoints: number; coverageMs: number }
export interface UsageMetrics extends UsageReport {
  paceLabel: string
  consumedPoints: number | null
  dailyUsage: DailyUsage[]
  hourlyUsage: number[]
  hourlyCoverage: number[]
  hourlyDays: number[]
  observedDays: number
  shortPressureMs: number
  weeklyPressureMs: number
  confidence: string
  habitReady: boolean
}
export type ReportQuery = {startAt: string; endAt: string; source: UsageSample['source']; scopeId: string; timeZone: string}
export function calculateUsageMetrics(input: UsageSample[], query: ReportQuery): UsageMetrics {
  const range = validateHistoryQuery(query)
  const formatter = new Intl.DateTimeFormat('en-CA', {timeZone: query.timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23'})
  const samples = [...new Map(input.map(validateHistorySample).filter(s => sameScope(s, range) && s.sampledAt >= range.startAt && s.sampledAt < range.endAt)
    .map(s => [s.sampledAt, s])).values()].sort((a,b) => a.sampledAt.localeCompare(b.sampledAt))
  const daily = new Map<string, DailyUsage>(), hourly = Array<number>(24).fill(0), warnings: string[] = []
  const hourlyCoverage = Array<number>(24).fill(0), hourDates = Array.from({length:24}, () => new Set<string>())
  let shortPressureMs=0, weeklyPressureMs=0
  let coverageMs = 0, consumed = 0, peak: number | null = null, shortPressure = 0, weeklyPressure = 0, breaks = 0
  const parts = (time: number) => {
    const entries = Object.fromEntries(formatter.formatToParts(time).map(p => [p.type,p.value]))
    return {date: `${entries.year}-${entries.month}-${entries.day}`, hour: Number(entries.hour)}
  }
  // Keep zero-coverage days visible as gaps, not zero consumption.
  for (let t = Date.parse(range.startAt); t < Date.parse(range.endAt); t += 3600_000) {
    const date = parts(t).date
    if (!daily.has(date)) daily.set(date, {date, consumedPoints: 0, coverageMs: 0})
  }
  const lastDate = parts(Date.parse(range.endAt) - 1).date
  if (!daily.has(lastDate)) daily.set(lastDate, {date: lastDate, consumedPoints: 0, coverageMs: 0})
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i-1], b = samples[i], start = Date.parse(a.sampledAt), end = Date.parse(b.sampledAt), duration = end - start
    if (duration <= 0 || duration > 300_000 || a.shortWindowResetAt !== b.shortWindowResetAt || a.weeklyResetAt !== b.weeklyResetAt
      || b.shortWindowRemaining > a.shortWindowRemaining || b.weeklyRemaining > a.weeklyRemaining) { breaks++; continue }
    // Linear interpolation is an observation estimate, not a provider measurement.
    const lowDuration = (before: number, after: number, threshold: number) => before <= threshold ? duration : after < threshold ? duration*(threshold-after)/(before-after) : 0
    shortPressureMs += lowDuration(a.shortWindowRemaining,b.shortWindowRemaining,25)
    weeklyPressureMs += lowDuration(a.weeklyRemaining,b.weeklyRemaining,22)
    const points = a.shortWindowRemaining - b.shortWindowRemaining
    const rate = points * 3600_000 / duration
    coverageMs += duration; consumed += points; peak = Math.max(peak ?? 0, rate)
    if (a.shortWindowRemaining > 25 && b.shortWindowRemaining <= 25) shortPressure++
    if (a.weeklyRemaining > 22 && b.weeklyRemaining <= 22) weeklyPressure++
    // Split at minute boundaries: hour/day/DST attribution uses the selected time zone.
    for (let cursor = start; cursor < end;) {
      const next = Math.min(end, (Math.floor(cursor / 60_000) + 1) * 60_000), span = next - cursor
      const {date, hour} = parts(cursor + span / 2), share = points * span / duration
      const day = daily.get(date) ?? {date, consumedPoints: 0, coverageMs: 0}
      day.coverageMs += span; day.consumedPoints += share; daily.set(date, day)
      hourly[hour] += share; hourlyCoverage[hour] += span; hourDates[hour].add(date); cursor = next
    }
  }
  if (samples.length < 2 || coverageMs === 0) warnings.push('数据不足：尚无连续有效片段，无法计算消耗速度。')
  if (coverageMs < Date.parse(range.endAt) - Date.parse(range.startAt)) warnings.push('记录未覆盖整个报告区间；未记录时段不按零消耗计算。')
  if (breaks) warnings.push(`有 ${breaks} 处重置、额度回升或超过 5 分钟的断档，已排除跨段计算。`)
  warnings.push('最多保留 90 天、每个来源和账号 100,000 条；统计仅反映保留且有效的片段。')
  if (query.source === 'mock') warnings.push('模拟数据示意，不代表真实账号或实际使用习惯。')
  const activePeriods = hourly.map((points, hour) => ({points,hour})).filter(v => v.points > 0)
    .sort((a,b) => b.points-a.points || a.hour-b.hour).slice(0,3).map(v => `${String(v.hour).padStart(2,'0')}:00–${String(v.hour+1).padStart(2,'0')}:00`)
  const average = coverageMs ? consumed * 3600_000 / coverageMs : null
  const observedDays = [...daily.values()].filter(d => d.coverageMs >= 30*60_000).length
  const habitReady = observedDays >= 3 && coverageMs >= 6*3600_000
  const confidence = habitReady ? '可描述观测规律' : '记录不足以判断习惯'
  const paceLabel = confidence
  return { ...query, paceLabel, observedDays, shortPressureMs, weeklyPressureMs, confidence, habitReady, hourlyCoverage, hourlyDays: hourDates.map(d => d.size), sampleCount: samples.length, coverageMs, averageBurnRate: coverageMs ? consumed * 3600_000 / coverageMs : null,
    peakBurnRate: peak, consumedPoints: coverageMs ? consumed : null, activePeriods, shortQuotaPressureCount: shortPressure,
    weeklyQuotaPressureCount: weeklyPressure, dailyUsage: [...daily.values()].sort((a,b) => a.date.localeCompare(b.date)), hourlyUsage: hourly,
    suggestions: [], warnings }
}
