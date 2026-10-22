import type { UsageMetrics } from '../history/usageMetrics'
export interface Achievement {name: string; evidence: string}
export function achievements(r: UsageMetrics): Achievement[] {
  if (!r.habitReady || !r.consumedPoints) return []
  const result: Achievement[]=[]
  const qualifying = r.dailyUsage.filter(d => d.coverageMs>=30*60_000 && d.consumedPoints>0)
  if (qualifying.length>=7) result.push({name:'足迹收藏家',evidence:`${qualifying.length} 个日期留下了有效消耗记录；不要求连续打卡。`})
  const morning=r.hourlyUsage.slice(6,12).reduce((a,b)=>a+b,0)
  const daylight=r.hourlyUsage.slice(8,20).reduce((a,b)=>a+b,0)
  if (morning/r.consumedPoints>=.6) result.push({name:'晨光搭档',evidence:`已观测消耗的 ${(100*morning/r.consumedPoints).toFixed(0)}% 在 06:00–12:00；可能受开启时段影响。`})
  else if (daylight/r.consumedPoints>=.8) result.push({name:'日光同行者',evidence:`已观测消耗的 ${(100*daylight/r.consumedPoints).toFixed(0)}% 在 08:00–20:00；仅描述记录片段。`})
  if (r.observedDays>=7 && !r.shortPressureMs && !r.weeklyPressureMs) result.push({name:'余粮守护者',evidence:`${r.observedDays} 个有效日期的记录片段内，未观测到低额度持续时间。`})
  return result
}
export function compareReports(current: UsageMetrics, previous: UsageMetrics): string {
  if (!current.habitReady || !previous.habitReady || previous.averageBurnRate===null || current.averageBurnRate===null) return '上期对比暂不可用：两期都需要至少 3 个有效日期和 6 小时有效记录。'
  const ratio=current.coverageMs/previous.coverageMs
  const overlap=current.hourlyCoverage.reduce((sum,ms,h)=>sum+Math.min(ms/current.coverageMs,previous.hourlyCoverage[h]/previous.coverageMs),0)
  if (ratio<.5 || ratio>2 || overlap<.7) return '两期观测时长或时段分布差异较大，暂不计算增减百分比，避免把采样差异当成习惯变化。'
  if (previous.averageBurnRate===0) return `上期有效片段未观测到消耗，本期平均 ${current.averageBurnRate.toFixed(1)} 个百分点/小时；零基数不计算增幅。`
  const change=100*(current.averageBurnRate/previous.averageBurnRate-1)
  return `与上期对应已过去时长相比，有效片段平均消耗速度${change>=0?'增加':'减少'} ${Math.abs(change).toFixed(1)}%；覆盖时长 ${(current.coverageMs/3600_000).toFixed(1)} / ${(previous.coverageMs/3600_000).toFixed(1)} 小时。这不表示工作效率或完整消耗量的变化。`
}
