import { useMemo, useState } from 'react'
import type { TaskRecord } from '../../electron/taskLedgerSchema'
import { timingAdvice, type CurrentQuota, type TaskAdvice } from '../reports/taskAdvisor'
import type { ReportQuery } from '../history/usageMetrics'
export function TaskAdvicePanel({advice,scope,quota,tasks,demo=false}:{tasks:TaskRecord[];advice:TaskAdvice[];scope:ReportQuery;quota:CurrentQuota|null;demo?:boolean}){
  const [limit,setLimit]=useState(6),[deadline,setDeadline]=useState(''),[minutes,setMinutes]=useState(''),[short,setShort]=useState(''),[weekly,setWeekly]=useState(''),[urgent,setUrgent]=useState(false)
  const timing=useMemo(()=>deadline&&minutes&&short&&weekly?timingAdvice({...scope,deadlineAt:Number.isFinite(Date.parse(deadline))?new Date(deadline).toISOString():deadline,estimatedDurationMs:Number(minutes)*60000,shortPoints:Number(short),weeklyPoints:Number(weekly),urgent},quota):null,[deadline,minutes,short,weekly,urgent,quota,scope])
  const card=(a:TaskAdvice)=><article key={a.id} className="task-advice-card" data-advice-kind={a.kind}><h4>{a.title}</h4><p><b>依据：</b>{a.evidence}</p><p><b>建议：</b>{a.action}</p><p className="task-advice-limit">{a.limitation}</p>{a.taskIds.length>0&&<details><summary>关联任务（{a.taskIds.length}）</summary><p>{a.taskIds.join('、')}</p></details>}</article>
  return <section className="task-advice" aria-label="任务使用建议"><h3>任务使用建议 <small>{demo?'模拟建议':'随账本自动生成'}</small></h3>
    <p>依据当前报告区间的实际记录生成规则建议；不调用大模型，不自动改模型或执行任务。阈值需随试用校准。</p>
    {advice.slice(0,limit).map(card)}
    {advice.length>limit&&<button onClick={()=>setLimit(n=>n+6)}>再看 {Math.min(6,advice.length-limit)} 条（共 {advice.length} 条）</button>}
    {!demo&&<details className="task-timing"><summary>仅评估额度等待时间（不选择模型）</summary><p>使用当前账号的最新额度，与报告区间无关。填写你或任务分析模块给出的预算；未知时留空。这里只给建议，不会设置提醒或提交任务。</p>
      <div className="history-filters">
        <label>截止时间（本机时区）<input aria-label="任务截止时间" type="datetime-local" value={deadline} onChange={e=>setDeadline(e.target.value)}/></label>
        <label>预计分钟<input aria-label="预计任务分钟" type="number" min="1" value={minutes} onChange={e=>setMinutes(e.target.value)}/></label>
        <label>预计短周期百分点<input aria-label="预计短周期额度" type="number" min="0" max="100" step="0.1" value={short} onChange={e=>setShort(e.target.value)}/></label>
        <label>预计周额度百分点<input aria-label="预计周额度" type="number" min="0" max="100" step="0.1" value={weekly} onChange={e=>setWeekly(e.target.value)}/></label>
        <label><input type="checkbox" aria-label="紧急任务" checked={urgent} onChange={e=>setUrgent(e.target.checked)}/>紧急任务</label>
      </div>
      {timing?card(timing):<p>补全截止时间、预计耗时及两种额度预算后，自动计算建议。</p>}
    </details>}
  </section>
}
