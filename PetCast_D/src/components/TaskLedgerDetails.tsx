import { useMemo, useState } from 'react'
import type { TaskRecord, TaskEvaluation, TaskLedger } from '../history/TaskLedger'
import { filterTasks, taskCsv } from '../reports/taskExport'
import { TaskEvaluationForm } from './TaskEvaluationForm'
export function TaskLedgerDetails({tasks,events,ledger,demo}:{tasks:TaskRecord[];events:TaskEvaluation[];ledger:TaskLedger;demo:boolean}){
  const [search,setSearch]=useState(''),[model,setModel]=useState(''),[category,setCategory]=useState(''),[status,setStatus]=useState(''),[page,setPage]=useState(0)
  const rows=useMemo(()=>filterTasks(tasks,{search,model,category,status}),[tasks,search,model,category,status])
  const models=[...new Set(tasks.flatMap(t=>t.calls).map(c=>JSON.stringify([c.provider,c.model])))],categories=[...new Set(tasks.map(t=>t.category))]
  const pages=Math.max(1,Math.ceil(rows.length/20)),current=Math.min(page,pages-1)
  function download(){const blob=new Blob([taskCsv(rows,events)],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`PetCast-${demo?'demo-':''}tasks-${new Date().toISOString().slice(0,10)}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
  return <details className="task-ledger-details"><summary>逐任务 / 逐调用明细（{tasks.length} 个任务）</summary>
    <div className="history-filters"><label>任务搜索<input aria-label="任务记录搜索" value={search} onChange={e=>{setSearch(e.target.value);setPage(0)}} placeholder="任务 ID 或名称"/></label>
    <label>模型<select aria-label="任务记录模型" value={model} onChange={e=>{setModel(e.target.value);setPage(0)}}><option value="">全部模型</option>{models.map(k=><option key={k} value={k}>{JSON.parse(k).join(' / ')}</option>)}</select></label>
    <label>类别<select aria-label="任务记录类别" value={category} onChange={e=>{setCategory(e.target.value);setPage(0)}}><option value="">全部类别</option>{categories.map(c=><option key={c}>{c}</option>)}</select></label>
    <label>状态<select aria-label="任务记录状态" value={status} onChange={e=>{setStatus(e.target.value);setPage(0)}}><option value="">全部状态</option><option value="succeeded">成功</option><option value="failed">失败</option><option value="cancelled">取消</option></select></label>
    <button disabled={!rows.length} onClick={download}>导出筛选结果 CSV</button></div>
    <p>本报告区间筛选到 {rows.length} 个任务；第 {current+1} / {pages} 页，每页 20 个。导出包含筛选后的全部页，未知计量留空，缓存输入为输入子集；不会导出任务正文。</p>
    <div className="task-detail-rows">{rows.slice(current*20,(current+1)*20).map(t=><details key={t.id}><summary>{t.label} · {t.category} · {t.status} · {t.id}</summary>
      <p>{t.startedAt} → {t.endedAt} · {t.origin==='import'?'用户导入，未经服务商核验':'执行器上报'}</p>
      <ul>{t.calls.map(c=><li key={c.id}>{c.id} → {c.taskId} · {c.provider}/{c.model} · 第 {c.attempt} 次尝试 · {c.status} · {((Date.parse(c.endedAt)-Date.parse(c.startedAt))/1000).toFixed(1)} 秒 · Token {c.usage?`${c.usage.inputTokens} 入 / ${c.usage.outputTokens} 出`:'未知'} · 成本 {c.cost?`${c.cost.amount} ${c.cost.currency}（${c.cost.basis==='price-estimate'?'估算':'服务商上报'}）`:'未知'}{c.cost?.pricing&&<p>价格版本 {c.cost.pricing.version} · 生效 {c.cost.pricing.effectiveAt} · 来源 {c.cost.pricing.sourceUrl}</p>}</li>)}</ul>
      {!demo&&<TaskEvaluationForm key={t.id+':'+(events.filter(e=>e.taskId===t.id).at(-1)?.id??'')} task={t} events={events} ledger={ledger}/>}
    </details>)}</div>
    <div className="history-actions"><button disabled={current===0} onClick={()=>setPage(current-1)}>上一页任务</button><button disabled={current>=pages-1} onClick={()=>setPage(current+1)}>下一页任务</button></div>
  </details>
}
