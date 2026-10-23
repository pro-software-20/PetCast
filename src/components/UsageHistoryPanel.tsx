import { useEffect, useMemo, useState } from 'react'
import type { UsageSample, UsageHistoryStore } from '../types/usageHistory'
import type { UsageMetrics } from '../history/usageMetrics'
import { reportQuery, weeklyReport } from '../reports/weeklyReport'
import { createMonthlyDemo, monthlyReport } from '../reports/monthlyReport'
import { calendarRange, calendarQuery, previousQuery, localDate, DEFAULT_SETTINGS, SETTINGS_KEY, validateSettings, type ReportSettings } from '../reports/reportCalendar'
import { achievements, compareReports } from '../reports/reportInsights'
import { RecommendationWorkspace } from './RecommendationWorkspace'
import { TaskReportPanel } from './TaskReportPanel'
import type { CurrentQuota } from '../reports/taskAdvisor'

type Scope = {source: UsageSample['source']; scopeId: string}
const rate = (v: number | null) => v === null ? '数据不足' : `${v.toFixed(1)}`
const duration = (ms: number) => ms < 3600_000 ? `${(ms / 60_000).toFixed(0)} 分钟` : `${(ms / 3600_000).toFixed(1)} 小时`
export function UsageHistoryPanel({ scope, store, revision, recordStatus, onClear, onClose, currentQuota=null }: {
  currentQuota?: CurrentQuota|null
  scope: Scope | null; store: UsageHistoryStore; revision: number; recordStatus: string
  onClear: (scope: Scope) => Promise<void>; onClose: () => void
}) {
  const [period, setPeriod] = useState<'week' | 'month' | 'demo'>('week')
  const [timeZone, setTimeZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai')
  const [refresh, setRefresh] = useState(0)
  useEffect(()=>{
    const update=()=>{if(document.visibilityState!=='hidden')setRefresh(v=>v+1)}
    const timer=window.setInterval(update,30_000)
    window.addEventListener('petcast:task-ledger-changed',update)
    window.addEventListener('storage',update)
    document.addEventListener('visibilitychange',update)
    return()=>{clearInterval(timer);window.removeEventListener('petcast:task-ledger-changed',update);window.removeEventListener('storage',update);document.removeEventListener('visibilitychange',update)}
  },[])
  const [confirmClear, setConfirmClear] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [clearError, setClearError] = useState('')
  const source = period === 'demo' ? 'mock' : scope?.source
  const scopeId = period === 'demo' ? 'mock-demo' : scope?.scopeId
  const [settings, setSettings] = useState<ReportSettings>(() => {try {return validateSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY)||JSON.stringify(DEFAULT_SETTINGS)))}catch{return DEFAULT_SETTINGS}})
  const [settingsError,setSettingsError]=useState('')
  const [anchor,setAnchor]=useState(() => localDate(Date.now(),timeZone))
  const [custom,setCustom]=useState<{start:string;end:string}|null>(null)
  const selected=custom??calendarRange(period==='week'?'week':'month',settings,timeZone,anchor)
  const queryState = useMemo(() => {
    if (!source || !scopeId) return {}
    try {return {query: period==='demo' ? reportQuery(source,scopeId,timeZone,30) : calendarQuery({source,scopeId},timeZone,selected.start,selected.end)}}
    catch(e){return {error:e instanceof Error?e.message:'报告日期无效'}}
  }, [source,scopeId,timeZone,period,selected.start,selected.end,revision,refresh])
  const query=queryState.query
  const changeSettings=(value:ReportSettings)=>{setSettings(value);setCustom(null);try{localStorage.setItem(SETTINGS_KEY,JSON.stringify(value));setSettingsError('')}catch{setSettingsError('本次设置已应用，但无法保存到下次启动。')}}
  const key = JSON.stringify(query ?? null)
  const [result, setResult] = useState<{key: string; report?: UsageMetrics; previous?: UsageMetrics; error?: string} | null>(null)
  const report = result?.key === key ? result.report : undefined
  const error = result?.key === key ? result.error : undefined
  const zones = [...new Set([Intl.DateTimeFormat().resolvedOptions().timeZone, 'Asia/Shanghai', 'UTC'])]
  useEffect(() => {
    let active = true
    if (!query) return
    const prior = previousQuery(query,custom?'custom':period==='week'?'week':'month')
    const pending = period === 'demo' ? Promise.resolve([createMonthlyDemo(new Date(query.endAt)), []]) : Promise.all([store.queryUsageSamples(query), store.queryUsageSamples(prior)])
    void pending.then(([samples, previousSamples]) => {
      const report = period === 'week' ? weeklyReport(samples, query) : monthlyReport(samples, query)
      if (active) setResult({key, report, previous: weeklyReport(previousSamples,prior)})
    }).catch(() => { if (active) setResult({key, error: '历史读取失败，原数据已保留。请检查历史文件或权限，然后重新读取。'}) })
    return () => { active = false }
  }, [key, query, period, store, custom])
  useEffect(() => {
    const close = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [onClose])
  useEffect(() => { setConfirmClear(false); setClearError('') }, [scope?.source, scope?.scopeId, period])
  const clear = async () => {
    if (!scope || clearing) return
    setClearing(true); setClearError('')
    try { await onClear(scope); setConfirmClear(false); setRefresh(v => v+1) }
    catch { setClearError('清除失败，原数据已保留。') }
    finally { setClearing(false) }
  }
  return <section className="history-panel" role="dialog" aria-label="使用历史与报告" onPointerDown={e => e.stopPropagation()}>
    <header className="history-header"><div><small>USAGE JOURNAL</small><h2>使用历史与报告</h2></div><button autoFocus aria-label="关闭历史报告" onClick={onClose}>×</button></header>
    <nav className="history-tabs" aria-label="报告周期">
      <button aria-pressed={period === 'week'} onClick={() => {setPeriod('week');setCustom(null)}}>周报</button>
      <button aria-pressed={period === 'month'} onClick={() => {setPeriod('month');setCustom(null)}}>月报 · 自然月</button>
      <button aria-pressed={period === 'demo'} onClick={() => {setPeriod('demo');setCustom(null)}}>月报示意</button>
      <label>时区 <select aria-label="报告时区" value={timeZone} onChange={e => {setTimeZone(e.target.value);setAnchor(localDate(Date.now(),e.target.value));setCustom(null)}}>{zones.map(zone => <option key={zone}>{zone}</option>)}</select></label>
    </nav>
    <div className="history-scroll">
      {period!=='demo'&&<div className="history-filters">
        {period==='week'?<><label>从 <select aria-label="周报开始星期" value={settings.weekStart} onChange={e=>changeSettings({...settings,weekStart:Number(e.target.value)})}>{['日','一','二','三','四','五','六'].map((d,i)=><option key={i} value={i}>周{d}</option>)}</select></label><label>到 <select aria-label="周报结束星期" value={settings.weekEnd} onChange={e=>changeSettings({...settings,weekEnd:Number(e.target.value)})}>{['日','一','二','三','四','五','六'].map((d,i)=><option key={i} value={i}>周{d}</option>)}</select>（含当天）</label><label>所在周 <input aria-label="所在周日期" type="date" value={anchor} onChange={e=>{if(e.target.value){setAnchor(e.target.value);setCustom(null)}}}/></label></>:<label>月份 <input aria-label="报告月份" type="month" value={anchor.slice(0,7)} onChange={e=>{if(e.target.value){setAnchor(e.target.value+'-01');setCustom(null)}}}/></label>}
        <label>起日 <input aria-label="报告开始日期" type="date" value={selected.start} onChange={e=>{if(e.target.value)setCustom({...selected,start:e.target.value})}}/></label>
        <label>止日 <input aria-label="报告结束日期" type="date" value={selected.end} onChange={e=>{if(e.target.value)setCustom({...selected,end:e.target.value})}}/></label>
        <button onClick={()=>{setAnchor(localDate(Date.now(),timeZone));setCustom(null)}}>恢复本{period==='week'?'周':'月'}</button>
        <p>止日包含全天；当前周期只统计到现在。周报可跨周（如周五至下周四）；同一星期表示单日。手动改日期后按自定义区间统计。</p>
      </div>}
      {(queryState.error||settingsError)&&<p role="alert" className="history-error">{queryState.error||settingsError}</p>}
      <p className={`history-source ${source === 'mock' ? 'is-demo' : ''} ${error ? 'has-error' : ''}`}>{period === 'demo' ? '模拟月报示意 · 不代表真实习惯 · 不保存到历史' : scope ? `${scope.source === 'real' ? '当前账号真实记录' : '本机模拟记录'} · ${error ? '本次历史读取失败' : recordStatus}` : '尚未确认当前账号，请先成功读取真实额度，或明确切换到模拟演示。'}</p>
      {query && <p className="history-range">{new Date(query.startAt).toLocaleString('zh-CN',{timeZone})} — {new Date(query.endAt).toLocaleString('zh-CN',{timeZone})} · {timeZone}</p>}
      {error && <div role="alert" className="history-error">{error}</div>}
      {query && !report && !error && <p role="status">正在读取历史…</p>}
      {report && <>
        <div className="history-summary">
          <div><span>记录样本</span><strong>{report.sampleCount}</strong><small>{period === 'demo' ? '条 · 独立模拟示意' : '条 · 当前来源和账号'}</small></div>
          <div><span>有效覆盖</span><strong>{duration(report.coverageMs)}</strong><small>{report.observedDays} 个日期 ≥30 分钟；未记录不算零</small></div>
          <div><span>平均消耗速度</span><strong>{rate(report.averageBurnRate)}</strong><small>5h 额度百分点 / 小时</small></div>
          <div><span>峰值消耗速度</span><strong>{rate(report.peakBurnRate)}</strong><small>有效采样片段估算</small></div>
        </div>
        <p className="history-source">{period==='month'?'月度复盘：长期分布、上期变化与习惯线索。':'本期复盘：消耗节奏、低额度时段与下一步建议。'} 观测消耗合计 {rate(report.consumedPoints)} 个百分点，可跨刷新周期累计超过 100。</p>
        {period!=='demo'&&result?.previous&&<p className="history-comparison">{compareReports(report,result.previous)}<br/><small>上期参考：{new Date(result.previous.startAt).toLocaleDateString('zh-CN',{timeZone})} — {new Date(result.previous.endAt).toLocaleString('zh-CN',{timeZone})}；当前周期未结束时只取上期对应已过去时长。</small></p>}
        <div className="history-chart" aria-label="每日观测消耗">
          <h3>每日观测消耗 <small>5h 额度百分点 · 仅有效片段</small></h3>
          <div className="history-bars">{report.dailyUsage.map(day => {
            const maximum = Math.max(1, ...report.dailyUsage.map(v => v.consumedPoints))
            return <div className={`history-day ${day.coverageMs ? '' : 'no-data'}`} key={day.date} title={`${day.date}：${day.coverageMs ? `${day.consumedPoints.toFixed(1)} 百分点，有效覆盖 ${duration(day.coverageMs)}` : '未记录，不等于零消耗'}`}>
              <div className="history-bar-track"><i style={{height: day.coverageMs ? `${Math.max(2, day.consumedPoints/maximum*100)}%` : '0%'}} />{!day.coverageMs && <b>—</b>}</div><span>{day.date.slice(5)}</span>
            </div>
          })}</div><p>— 表示没有有效记录；短横条表示已观测但消耗为零。每日柱状图不是完整账单。</p>
        </div>
        {period==='month'&&<section className="history-chart"><h3>月内分段趋势 <small>每 7 个日期一段，按所选区间起日划分</small></h3><table className="history-trend-table"><thead><tr><th>日期段</th><th>观测消耗</th><th>有效覆盖</th><th>片段平均速度</th></tr></thead><tbody>{Array.from({length:Math.ceil(report.dailyUsage.length/7)},(_,i)=>{const days=report.dailyUsage.slice(i*7,i*7+7),coverage=days.reduce((s,d)=>s+d.coverageMs,0),points=days.reduce((s,d)=>s+d.consumedPoints,0);return <tr key={i}><td>{days[0].date.slice(5)} — {days[days.length-1].date.slice(5)}</td><td>{coverage?points.toFixed(1):'无记录'} 百分点</td><td>{duration(coverage)}</td><td>{coverage?(points*3600_000/coverage).toFixed(1):'数据不足'} /小时</td></tr>})}</tbody></table><p>分段覆盖不同，不直接把消耗总量变化视为习惯变化。</p></section>}
        <div className="history-observations"><span>证据状况 <b>{report.confidence}</b></span><span>短周期低额度持续 <b>{duration(report.shortPressureMs)}</b></span><span>周低额度持续 <b>{duration(report.weeklyPressureMs)}</b></span><span>5h 紧张进入次数 <b>{report.shortQuotaPressureCount}</b></span><span>周额度紧张进入次数 <b>{report.weeklyQuotaPressureCount}</b></span><span>已记录消耗集中时段 <b>{report.activePeriods.join('、') || (report.coverageMs ? '有效片段内未观测到消耗' : '数据不足')}</b></span></div>
        <section className="history-chart"><h3>一天中的消耗规律 <small>颜色按有效观测小时的消耗速度；悬停查看覆盖量</small></h3><div className="history-hours">{report.hourlyUsage.map((points,h)=>{const coverage=report.hourlyCoverage[h],value=coverage?points*3600_000/coverage:0,max=Math.max(1,...report.hourlyUsage.map((p,i)=>report.hourlyCoverage[i]?p*3600_000/report.hourlyCoverage[i]:0));return <div key={h} title={`${h}:00：${coverage?value.toFixed(1)+' 百分点/小时':'无记录'}；覆盖 ${duration(coverage)}，${report.hourlyDays[h]} 个日期`} style={{background:coverage?`rgba(45,126,156,${.12+.65*value/max})`:'#edf0f2'}}>{h}<small>{coverage?'●':'—'}</small></div>})}</div><p>这是开启记录时段的分布，不能推断未开启桌宠时的习惯。相邻记录内按均匀消耗估算时间分布。</p></section>
        <section className="history-chart"><h3>本期趣味称号 {period==='demo'&&<small>模拟称号，不计入真实记录</small>}</h3><div className="history-badges">{achievements(report).map(a=><div key={a.name}><b>✦ {a.name}</b><p>{a.evidence}</p></div>)}</div>{!achievements(report).length&&<p>暂未满足称号条件。正常使用即可，无需增加消耗或熬夜打卡。</p>}<p>称号随所选区间计算，附观测依据，不代表能力或效率评价。</p></section>

        <section className="history-advice"><h3>使用建议</h3><ul>{report.suggestions.map(text => <li key={text}>{text}</li>)}</ul></section>
        <section className="history-warnings"><h3>数据说明</h3><ul>{report.warnings.map(text => <li key={text}>{text}</li>)}</ul><p>习惯门槛为至少 3 个有效日期（每天 ≥30 分钟）、合计 ≥6 小时；具体时段还需覆盖至少 3 天和 1 小时。阈值是待用户试用校准的规则，不是统计置信度。低额度持续时长通过有效片段线性插值估算，初次采样已处于低额度也会计入。</p><p>额度百分点与 Token 数、金额不同，不能用于推算精确费用。</p></section>
      </>}
      {query&&!error&&<TaskReportPanel key={JSON.stringify([source,scopeId,period,timeZone,selected.start,selected.end])} query={query} revision={revision+refresh} currentQuota={period==='demo'?null:currentQuota} demo={period==='demo'}/>}
      {query&&<RecommendationWorkspace key={JSON.stringify([source,scopeId,period==='demo'])} scope={query} revision={revision+refresh} quota={period==='demo'?null:currentQuota} demo={period==='demo'}/>}
      <footer className="history-actions">
        {period !== 'demo' && scope && <><button disabled={clearing} onClick={() => setRefresh(v => v+1)}>刷新报告</button><button disabled={clearing} onClick={() => setConfirmClear(true)}>清除当前账号历史</button></>}
        {confirmClear && period !== 'demo' && <div className="history-confirm"><span>清除当前来源和账号的全部历史？其他账号、游戏存档不受影响，后续新采样会继续记录。</span><button disabled={clearing} onClick={() => void clear()}>{clearing ? '正在清除…' : '确认清除'}</button><button disabled={clearing} onClick={() => setConfirmClear(false)}>取消</button></div>}
        {clearError && <p role="alert">{clearError}</p>}
      </footer>
    </div>
  </section>
}
