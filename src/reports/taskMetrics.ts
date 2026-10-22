import { validateTaskRecord, type TaskRecord } from '../../electron/taskLedgerSchema'
import { sameScope } from '../../electron/historySchema'
import type { ReportQuery } from '../history/usageMetrics'
export function distribution(values:{id:string;value:number}[]){
  if(!values.length)return null
  const sorted=[...values].sort((a,b)=>a.value-b.value)
  return {count:values.length,average:values.reduce((s,v)=>s+v.value,0)/values.length,min:sorted[0],max:sorted[sorted.length-1]}
}
export function taskMetrics(input:TaskRecord[],query:ReportQuery){
  const unique=new Map<string,TaskRecord>()
  for(const raw of input){const t=validateTaskRecord(raw);if(sameScope(t,query)&&t.endedAt>=query.startAt&&t.endedAt<query.endAt){const old=unique.get(t.id);if(old&&JSON.stringify(old)!==JSON.stringify(t))throw Error('任务记录冲突');unique.set(t.id,t)}}
  const tasks=[...unique.values()],completed=tasks.filter(t=>t.status==='succeeded')
  const duration=distribution(completed.map(t=>({id:t.id,value:Date.parse(t.endedAt)-Date.parse(t.startedAt)})))
  const tokens=distribution(completed.filter(t=>t.calls.length>0&&t.calls.every(c=>c.usage!==null)).map(t=>({id:t.id,value:t.calls.reduce((s,c)=>s+c.usage!.inputTokens+c.usage!.outputTokens,0)})))
  const quotas=new Map<string,{id:string;value:number}[]>()
  for(const t of completed){if(!t.quota)continue;const key=t.quota.provider+' / '+t.quota.window;quotas.set(key,[...(quotas.get(key)??[]),{id:t.id,value:t.quota.points}])}
  const taskCosts=new Map<string,{id:string;value:number}[]>()
  for(const t of completed){if(!t.calls.length||t.calls.some(c=>!c.cost))continue
    const labels=new Set(t.calls.map(c=>c.cost!.currency+' / '+c.cost!.basis))
    if(labels.size!==1)continue
    const key=[...labels][0];taskCosts.set(key,[...(taskCosts.get(key)??[]),{id:t.id,value:t.calls.reduce((sum,c)=>sum+c.cost!.amount,0)}])
  }
  const costs=new Map<string,{amount:number;calls:number}>()
  const calls=tasks.flatMap(t=>t.calls),reportedTokens=calls.filter(c=>c.usage!==null).reduce((s,c)=>s+c.usage!.inputTokens+c.usage!.outputTokens,0)
  for(const c of calls){if(!c.cost)continue;const key=c.cost.currency+' / '+(c.cost.basis==='provider-reported'?'服务商上报':'估算');const row=costs.get(key)??{amount:0,calls:0};row.amount+=c.cost.amount;row.calls++;costs.set(key,row)}
  const expensive=[...tasks].filter(t=>t.calls.some(c=>c.usage)).sort((a,b)=>b.calls.reduce((s,c)=>s+(c.usage?c.usage.inputTokens+c.usage.outputTokens:0),0)-a.calls.reduce((s,c)=>s+(c.usage?c.usage.inputTokens+c.usage.outputTokens:0),0)).slice(0,5)
  return {taskCosts:[...taskCosts].map(([label,v])=>({label,stats:distribution(v)!})),tasks,completed:completed.length,failed:tasks.filter(t=>t.status==='failed').length,cancelled:tasks.filter(t=>t.status==='cancelled').length,duration,tokens,quotas:[...quotas].map(([label,v])=>({label,stats:distribution(v)!})),costs:[...costs].map(([label,value])=>({label,...value})),calls:calls.length,reportedCalls:calls.filter(c=>c.usage).length,reportedTokens,expensive}
}
export function callEvidence(task:TaskRecord){
  const calls=task.calls,usage=calls.filter(c=>c.usage),input=usage.reduce((s,c)=>s+c.usage!.inputTokens,0),output=usage.reduce((s,c)=>s+c.usage!.outputTokens,0)
  const evidence=[`${calls.length} 次调用，其中 ${calls.filter(c=>c.status==='failed').length} 次失败、${calls.filter(c=>c.attempt>1).length} 次重试尝试`]
  if(usage.length)evidence.push(`有计量的调用中：输入 ${input}、输出 ${output} Token；${input>output?'输入占比更高，可检查上下文是否重复':'输出占比不低，可检查任务是否要求过长输出'}`)
  if(usage.length<calls.length)evidence.push('部分调用无用量，当前合计不是完整任务消耗')
  evidence.push('以上是可追溯现象；是否浪费需结合任务结果人工判断。未保存提示词或任务正文。')
  return evidence
}
