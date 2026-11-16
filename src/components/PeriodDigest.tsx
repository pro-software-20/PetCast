import type { UsageMetrics } from '../history/usageMetrics'

export function PeriodDigest({report, monthly}:{report:UsageMetrics;monthly:boolean}) {
  const rows=[]
  const step=monthly?7:1
  for(let i=0;i<report.dailyUsage.length;i+=step){
    const days=report.dailyUsage.slice(i,i+step)
    rows.push({
      label:days.length===1?days[0].date.slice(5):days[0].date.slice(5)+' 至 '+days[days.length-1].date.slice(5),
      points:days.reduce((sum,d)=>sum+d.consumedPoints,0),
      coverage:days.reduce((sum,d)=>sum+d.coverageMs,0),
    })
  }
  const maximum=Math.max(1,...rows.map(r=>r.points))
  const peak=rows.filter(r=>r.coverage>0 && r.points>0).sort((a,b)=>b.points-a.points)[0]
  const advice=report.weeklyPressureMs>0?'安排批量任务前，先查看周额度和恢复时间。':
    report.shortPressureMs>0?'长任务开始前，先核对 5 小时额度。':
    report.habitReady && report.activePeriods.length?'在常用时段前检查剩余额度，再安排批量任务。':''
  return <section className="period-digest">
    <h3>{monthly?'月报概览':'周报概览'}</h3>
    {!report.coverageMs?<p>所选期间暂无有效消耗记录。</p>:<>
      <strong>{report.consumedPoints?.toFixed(1)} <small>个百分点</small></strong>
      <p>已观测的 5 小时额度消耗 · 覆盖 {(report.coverageMs/3600000).toFixed(1)} 小时</p>
      {peak&&<p>记录中消耗最多的{monthly?'日期段':'一天'}为 {peak.label}，共 {peak.points.toFixed(1)} 个百分点。</p>}
      {advice&&<p className="period-action">{advice}</p>}
      <h4>{monthly?'月内分段趋势':'每日消耗'}</h4>
      {rows.map(r=><div className="period-trend-row" key={r.label}>
        <span>{r.label}</span><span className="period-track" aria-hidden="true"><i style={{width:(100*r.points/maximum)+'%'}}/></span>
        <span>{r.coverage?r.points.toFixed(1):'未记录'}</span>
      </div>)}
    </>}
  </section>
}
