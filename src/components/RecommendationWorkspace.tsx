import { useEffect, useMemo, useState } from 'react'
import { createTaskLedger, type TaskRecord } from '../history/TaskLedger'
import { applyTaskEvaluations } from '../../electron/taskEvaluations'
import type { ReportQuery } from '../history/usageMetrics'
import type { CurrentQuota } from '../reports/taskAdvisor'
import { recommendationQuery } from '../history/recommendationHistory'
import { UnifiedPlanPanel } from './UnifiedPlanPanel'
export function RecommendationWorkspace({scope,revision,quota,demo}:{scope:ReportQuery;revision:number;quota:CurrentQuota|null;demo:boolean}){
  const ledger=useMemo(()=>createTaskLedger(window.petcast),[]),[days,setDays]=useState<30|90>(90)
  const [state,setState]=useState<{key:string;tasks:TaskRecord[];error?:string}>()
  const key=JSON.stringify([scope.source,scope.scopeId,days,revision,demo])
  const query=useMemo(()=>recommendationQuery(scope,days,Date.now(),scope.timeZone),[key])
  useEffect(()=>{let active=true
    if(demo){setState({key,tasks:[]});return}
    void Promise.all([ledger.queryTaskRecords(query),ledger.queryTaskEvaluations(query)]).then(([tasks,events])=>{if(active)setState({key,tasks:applyTaskEvaluations(tasks,events)})}).catch(()=>{if(active)setState({key,tasks:[],error:'推荐历史读取失败，请刷新；不会使用旧样本继续推荐。'})})
    return()=>{active=false}
  },[key,ledger,query,demo])
  const current=state?.key===key?state:undefined
  return <section className="history-chart" aria-label="独立历史综合推荐"><h3>待办任务推荐</h3>
    {!demo&&<><label>推荐历史范围 <select aria-label="推荐历史天数" value={days} onChange={e=>setDays(Number(e.target.value) as 30|90)}><option value={30}>最近 30 天</option><option value={90}>最近 90 天</option></select></label>
    <p>独立于上方周月报。{new Date(query.startAt).toLocaleString('zh-CN')} — {new Date(query.endAt).toLocaleString('zh-CN')}；已读取 {current?.tasks.length??0} 个结束任务。使用最新评价；无评价不当成达标。</p></>}
    {current?.error&&<p role="alert">{current.error}</p>}{!current&&!demo&&<p role="status">正在读取推荐历史…</p>}
    <UnifiedPlanPanel tasks={current?.tasks??[]} scope={query} quota={quota} demo={demo}/>
  </section>
}
