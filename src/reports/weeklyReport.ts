import type { UsageSample } from '../types/usageHistory'
import { calculateUsageMetrics, type ReportQuery } from '../history/usageMetrics'
import { habitAdvice } from './habitAdvisor'
export function reportQuery(source: UsageSample['source'], scopeId: string, timeZone: string, days: 7 | 30, now = new Date()): ReportQuery {
  return {source, scopeId, timeZone, startAt: new Date(now.getTime() - days * 86400_000).toISOString(), endAt: now.toISOString()}
}
export function weeklyReport(samples: UsageSample[], query: ReportQuery) {
  const report = calculateUsageMetrics(samples, query)
  return {...report, suggestions: habitAdvice(report)}
}
