import { useEffect, useState } from 'react'
import type { ExecutionRun } from '../../electron/executionJournal'
import type { TaskLedger } from '../history/TaskLedger'
import type { HistoryScope } from '../../electron/historySchema'
export function ExecutionRecoveryPanel({ledger,scope,revision}:{ledger:TaskLedger;scope:HistoryScope;revision:string}){
  const [runs,setRuns]=useState<ExecutionRun[]>([]),[error,setError]=useState(''),[saved,setSaved]=useState(false)
  useEffect(()=>{let active=true;setSaved(false);void ledger.queryExecutions(scope).then(rows=>{if(active){setRuns(rows);setError('')}}).catch(()=>{if(active){setRuns([]);setError('执行日志无法读取；请检查存储，不要据此重跑任务。')}});return()=>{active=false}},[ledger,scope.source,scope.scopeId,revision])
  const unfinished=runs.filter(r=>!r.finished),finished=runs.filter(r=>r.finished)
  return <details aria-label="执行恢复检查" className="history-chart" open={unfinished.length>0}><summary>执行恢复检查 · {unfinished.length} 个未结束任务</summary>
    <p>这里只核对执行记录，不会自动调用模型。未结束任务可能仍在运行，也可能已中断；请先向执行模块或服务商核实。</p>
    {error&&<p role="alert">{error}</p>}
    {!unfinished.length&&<p>当前账号没有未结束的执行记录。</p>}
    {unfinished.map(r=><article key={r.task.id}><b>{r.task.label} · {r.task.id}</b><p>已保存 {r.task.calls.length} 次调用；另有 {r.pending.length} 次已记录发起、结果待核实。未知费用不能当作零。</p>
      <details><summary>已保存与待核实调用</summary><ul>{r.task.calls.map(c=><li key={c.id}>{c.id} · {c.provider}/{c.model} · {c.status==='succeeded'?'已返回':'失败'} · {c.cost?`${c.cost.amount} ${c.cost.currency}`:'费用未知'}</li>)}{r.pending.map(c=><li key={c.id}>{c.id} · {c.provider}/{c.model} · 结果待核实，禁止自动重试</li>)}</ul></details></article>)}
    {finished.length>0&&<><p>{finished.length} 个任务已有结束日志。若报告中缺失，可补存原记录；不会重复计费或覆盖冲突记录。</p><button onClick={()=>void ledger.reconcileExecutions(scope).then(()=>setSaved(true)).catch(()=>setError('补存失败；请检查存储或任务 ID 冲突，原记录已保留。'))}>补存已结束任务</button>{saved&&<p role="status">已核对并补存结束记录。</p>}</>}
  </details>
}
