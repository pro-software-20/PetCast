import { useMemo } from 'react'
import type { TaskRecord } from '../history/TaskLedger'
import { taskHabits, taskTiming } from '../reports/taskHabits'
import { taskInsights } from '../reports/taskInsights'

const duration = (ms:number|null)=>ms===null?'未记录':ms<60000?Math.round(ms/1000)+' 秒':(ms/60000).toFixed(1)+' 分钟'
export function TaskHabitSummary({tasks}:{tasks:TaskRecord[]}) {
  const stats=useMemo(()=>taskHabits(tasks),[tasks])
  const insights=useMemo(()=>taskInsights(tasks),[tasks])
  if(!tasks.length)return <p>本期暂无任务反馈</p>
  return <section className="history-chart"><h3>使用习惯与任务反馈</h3>
    <p>使用模型　{stats.models.slice(0,3).map(([s,n])=>s+'（'+n+' 次）').join('、')||'暂无记录'}</p>
    <p>任务类型　{stats.categories.slice(0,3).map(([s,n])=>s+'（'+n+' 项）').join('、')}</p>
    <p>多 AI 参与　{stats.multiAiTasks} 项任务</p>
    <details><summary>规划与执行用量</summary>{stats.stages.filter(s=>s.calls>0).map(s=><p key={s.stage}>
      {s.stage==='planning'?'主控规划':s.stage==='execution'?'任务执行':'未分类'} · {s.calls} 次调用 · {s.measured?s.tokens.toLocaleString()+' Token':'用量未记录'}（{s.measured} 次有计量）
    </p>)}</details>
    <p>重试 {stats.retryCalls} 次{stats.measuredRetries>0 && '，其中 '+stats.measuredRetries+' 次共上报 '+stats.retryTokens.toLocaleString()+' Token'}</p>
    {insights.length>0 && <section aria-label="本期任务建议"><h4>本期任务建议</h4>{insights.map(item=><details key={item.id}>
      <summary>{item.title} · {item.evidence}</summary><p>{item.action}</p>
      <p>相关任务：{item.taskIds.map(id=>tasks.find(t=>t.id===id)?.label??id).slice(0,5).join('、')}{item.taskIds.length>5?'等 '+item.taskIds.length+' 项':''}</p>
    </details>)}</section>}
    <details><summary>各平台的调用与用量</summary>{stats.providers.map(p=><p key={p.provider}>{p.provider} · {p.calls} 次调用 · {p.measured ? p.tokens.toLocaleString()+' Token' : '用量未知'}（{p.measured} 次有记录）</p>)}</details>
    <details open><summary>任务明细（{tasks.length} 项）</summary>{tasks.slice().sort((a,b)=>b.endedAt.localeCompare(a.endedAt)).slice(0,20).map(t=>{
      const time=taskTiming(t)
      return <details key={t.id}><summary>{t.label} · {duration(time.elapsed)} · {{succeeded:'成功',failed:'失败',cancelled:'已取消'}[t.status]}</summary>
        <p>{[...new Set(t.calls.map(c=>c.provider+' / '+c.model))].join('、')||'执行 AI 未记录'} · 失败调用 {t.calls.filter(c=>c.status==='failed').length} 次 · 重试 {t.calls.filter(c=>c.attempt>1).length} 次</p>
        {t.calls.some(c=>c.stage)&&<p>规划 {t.calls.filter(c=>c.stage==='planning').length} 次 · 执行 {t.calls.filter(c=>c.stage==='execution').length} 次 · 未分类 {t.calls.filter(c=>!c.stage).length} 次</p>}
        <p>调用占时 {duration(time.active)} · 调用外耗时 {duration(time.gap)} · 人工等待 {duration(t.humanWaitMs??null)}</p>
      </details>})}{tasks.length>20&&<small>显示最近 20 项，可在任务账本查看全部。</small>}</details>
  </section>
}

