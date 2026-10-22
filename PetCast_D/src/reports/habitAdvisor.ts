import type { UsageMetrics } from '../history/usageMetrics'
/** Rules describe measured evidence, never infer task urgency or personal productivity. */
export function habitAdvice(report: UsageMetrics): string[] {
  const advice: string[] = []
  if (!report.habitReady) advice.push(`习惯证据不足：有效覆盖 ${(report.coverageMs/3600_000).toFixed(1)} 小时、${report.observedDays} 个有效日期。积累至少 3 天（每天至少 30 分钟）、合计 6 小时后再描述规律；这是首版证据门槛，不代表统计学置信度。`)
  if (report.shortPressureMs > 0) advice.push(`观测事实：短周期低额度约持续 ${(report.shortPressureMs/60_000).toFixed(0)} 分钟，进入 ${report.shortQuotaPressureCount} 次。建议：先检查当前剩余额度和实际恢复时间，再决定是否推迟非紧急任务；历史低额度不等于现在仍不足。`)
  if (report.weeklyPressureMs > 0) advice.push(`观测事实：周低额度约持续 ${(report.weeklyPressureMs/60_000).toFixed(0)} 分钟。建议：为重要任务预留额度；具体优先级仍需结合任务截止时间。`)
  const eligible = report.hourlyUsage.map((points,hour) => ({hour,points,rate: points*3600_000/(report.hourlyCoverage[hour]||1)}))
    .filter(v => v.points>0 && report.hourlyDays[v.hour]>=3 && report.hourlyCoverage[v.hour]>=3600_000).sort((a,b)=>b.rate-a.rate)
  if (report.habitReady && eligible.length) {
    const top=eligible[0]
    advice.push(`观测规律：${top.hour}:00–${top.hour+1}:00 的有效片段平均消耗 ${top.rate.toFixed(1)} 个百分点/小时，覆盖 ${report.hourlyDays[top.hour]} 个日期。建议：在这个时段前检查可用额度；仅比较有足够记录的时段，不能推断全天习惯。`)
  }
  if (report.coverageMs>0 && !report.shortPressureMs && !report.weeklyPressureMs) advice.push('有效片段内未观测到低额度持续时间。建议保持当前安排；未记录时段无法判断，也不能据此推荐更贵套餐。')
  return advice
}
