import { ExecutionRecoveryPanel } from './ExecutionRecoveryPanel'
import { applyTaskEvaluations, type TaskEvaluation } from '../../electron/taskEvaluations'
import { TaskLedgerDetails } from './TaskLedgerDetails'
import { useEffect, useMemo, useState } from 'react'
import { createTaskLedger, type TaskRecord } from '../history/TaskLedger'
import { validateTaskRecord } from '../../electron/taskLedgerSchema'
import { sameScope } from '../../electron/historySchema'
import type { ReportQuery } from '../history/usageMetrics'
import { TaskAdvicePanel } from './TaskAdvicePanel'
import { taskAdvice, type CurrentQuota } from '../reports/taskAdvisor'
import { callEvidence, taskMetrics } from '../reports/taskMetrics'
const num=(n:number)=>n.toLocaleString('zh-CN',{maximumFractionDigits:6})
export function TaskReportPanel({query,revision,demo=false,currentQuota=null}:{query:ReportQuery;revision:number;demo?:boolean;currentQuota?:CurrentQuota|null}){
  const ledger=useMemo(()=>createTaskLedger(window.petcast),[]),[reload,setReload]=useState(0)
  const key=JSON.stringify(query)+':'+revision+':'+reload
  const [state,setState]=useState<{key:string;tasks?:TaskRecord[];events?:TaskEvaluation[];error?:string}>(),[message,setMessage]=useState(''),[confirm,setConfirm]=useState(false)
  useEffect(()=>{let active=true;setMessage('');setConfirm(false)
    const pending=demo?Promise.resolve([demoTasks(query),[]] as [TaskRecord[],TaskEvaluation[]]):Promise.all([ledger.queryTaskRecords(query),ledger.queryTaskEvaluations(query)])
    void pending.then(([tasks,events])=>{if(active)setState({key,tasks,events})}).catch(()=>{if(active)setState({key,error:'任务记录读取失败，原数据已保留。'})})
    return()=>{active=false}
  },[key,ledger,demo])
  const current=state
  const report=useMemo(()=>current?.tasks?taskMetrics(current.tasks,query):null,[current,query])
  const suggestions=useMemo(()=>current?.tasks?taskAdvice(applyTaskEvaluations(current.tasks,current.events??[]),query):[],[current,query])
  async function importFile(file:File){
    try{if(file.size>2*1024*1024)throw Error('文件不能超过 2 MB')
      const doc=JSON.parse(await file.text());if(doc.version!==1||!Array.isArray(doc.tasks)||doc.tasks.length>500)throw Error('需要 version:1 的任务导出文件，最多 500 条')
      const tasks=doc.tasks.map((v:unknown)=>validateTaskRecord({...v as object,origin:'import'}))
      if(tasks.some((t:TaskRecord)=>!sameScope(t,query)))throw Error('文件含其他账号或来源的记录，未导入')
      await ledger.appendTaskRecords(tasks);setReload(v=>v+1)
    }catch(e){setMessage(e instanceof Error?e.message:'导入失败，未修改记录')}
  }
  return <section className="history-chart task-report"><h3>任务完成与调用账本 <small>{demo?'独立模拟示意':'执行器上报 / 手动导入'}</small></h3>
    <p>按任务结束时间归入区间。耗时是开始到结束的经过时间，包含等待和重试；平均、最高、最低只统计成功任务。失败和取消的调用仍计入已知消耗。</p>
    {current?.error&&<p role="alert">{current.error}</p>}
    {!current&&<p>正在读取任务记录…</p>}
    {!demo&&<ExecutionRecoveryPanel ledger={ledger} scope={query} revision={key}/>}
    <TaskAdvicePanel tasks={report?.tasks??[]} advice={suggestions} scope={query} quota={currentQuota} demo={demo}/>
    {report&&<>

      <p>成功 {report.completed} · 失败 {report.failed} · 取消 {report.cancelled} · 调用 {report.calls} 次</p>
      {!report.tasks.length&&<p className="history-source">暂无任务执行记录。当前任务分析不等于执行；执行模块接入账本或导入其记录后，这里才会有真实统计。</p>}
      <table><thead><tr><th>成功任务指标</th><th>平均</th><th>最低</th><th>最高</th><th>有效任务数</th></tr></thead><tbody>
        <tr><td>完成时长（分钟）</td>{report.duration?<><td>{num(report.duration.average/60000)}</td><td title={report.duration.min.id}>{num(report.duration.min.value/60000)}</td><td title={report.duration.max.id}>{num(report.duration.max.value/60000)}</td><td>{report.duration.count}</td></>:<td colSpan={4}>数据不足</td>}</tr>
        <tr><td>上报 Token（含重试）</td>{report.tokens?<><td>{num(report.tokens.average)}</td><td title={report.tokens.min.id}>{num(report.tokens.min.value)}</td><td title={report.tokens.max.id}>{num(report.tokens.max.value)}</td><td>{report.tokens.count}/{report.completed}</td></>:<td colSpan={4}>尚无全部调用均提供 Token 的成功任务</td>}</tr>
        {report.taskCosts.map(q=><tr key={q.label}><td>费用 {q.label.replace('provider-reported','服务商上报').replace('price-estimate','估算')}</td><td>{num(q.stats.average)}</td><td title={q.stats.min.id}>{num(q.stats.min.value)}</td><td title={q.stats.max.id}>{num(q.stats.max.value)}</td><td>{q.stats.count}/{report.completed}</td></tr>)}
        {report.quotas.map(q=><tr key={q.label}><td>{q.label} 额度百分点</td><td>{num(q.stats.average)}</td><td title={q.stats.min.id}>{num(q.stats.min.value)}</td><td title={q.stats.max.id}>{num(q.stats.max.value)}</td><td>{q.stats.count}/{report.completed}</td></tr>)}
      </tbody></table>
      {!report.quotas.length&&<p>单任务额度尚不可用：仅接受执行器确认无其他并发消耗、且无刷新干扰的独占观测，不把账号额度下降直接分摊给任务。</p>}
      <p>已上报 Token 合计 {num(report.reportedTokens)}（覆盖 {report.reportedCalls}/{report.calls} 次调用；缺失不记作零）。缓存输入是输入的子集，不重复相加。</p>
      <p>已知成本：{report.costs.length?report.costs.map(c=>`${c.label} ${num(c.amount)}（${c.calls} 次调用）`).join('；'):'暂无成本记录'}。币种、上报金额和估算金额分别统计；订阅额度不折算金额。</p>
      <details><summary>高 Token 任务与可追溯线索（已知消耗前 5）</summary>{report.expensive.map(t=><div key={t.id}><b>{t.label} · {t.id}</b><ul>{callEvidence(t).map(s=><li key={s}>{s}</li>)}</ul></div>)}{!report.expensive.length&&<p>暂无可追溯的 Token 记录。</p>}</details>
      <TaskLedgerDetails tasks={report.tasks} events={current?.events??[]} ledger={ledger} demo={demo}/>

    </>}
    {!demo&&<div className="history-actions"><label className="history-file">导入任务记录 JSON<input type="file" accept=".json,application/json" aria-label="导入任务记录" onChange={e=>{const file=e.target.files?.[0];if(file)void importFile(file);e.target.value=''}}/></label><button onClick={()=>setConfirm(true)}>清除当前账号任务记录</button>{confirm&&<div className="history-confirm"><span>确认删除当前来源和账号的任务、评价及执行恢复日志？请先停止运行中的任务；删除后无法用日志核对待确认调用。额度历史不会删除。</span><button onClick={()=>void ledger.clearTaskRecords(query).then(()=>{setReload(v=>v+1);setConfirm(false)}).catch(()=>setMessage('清除未完全完成，请重新检查任务与执行恢复日志后重试。'))}>确认清除任务</button><button onClick={()=>setConfirm(false)}>取消</button></div>}</div>}
    {message&&<p role="alert">{message}</p>}
  </section>
}
function demoTasks(query:ReportQuery):TaskRecord[]{
  return [1,2,3].map((n)=>{const end=Date.parse(query.endAt)-n*3600_000,start=end-n*60_000,id=`demo-task-${n}`
    return {...query,id,label:['整理笔记','提取资料','生成报告'][n-1],category:'示意任务',status:'succeeded',origin:'executor',startedAt:new Date(start).toISOString(),endedAt:new Date(end).toISOString(),quota:{provider:'示意平台',window:'短周期',points:n*2,basis:'exclusive-observation'},calls:[{id:`demo-call-${n}`,taskId:id,provider:'示意平台',model:'示意模型',startedAt:new Date(start).toISOString(),endedAt:new Date(end).toISOString(),status:'succeeded',attempt:1,usage:{inputTokens:n*1000,outputTokens:n*200,cachedInputTokens:null,basis:'provider-reported'},cost:{amount:n*.01,currency:'USD',basis:'price-estimate'}}]}
  })
}
