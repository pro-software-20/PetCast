import { sameScope, validateHistoryScope, type HistoryScope } from './historySchema.js'
import { validateTaskRecord, type TaskRecord, type CallRecord, MAX_TASK_CALLS } from './taskLedgerSchema.js'

export interface ExecutionRun {owner:string;task:TaskRecord;pending:CallRecord[];finished:boolean}
export type ExecutionEvent = {kind:'begin';owner:string;task:TaskRecord}
  | {kind:'start'|'complete';owner:string;source:HistoryScope['source'];scopeId:string;taskId:string;call:CallRecord}
  | {kind:'finish';owner:string;task:TaskRecord}
export interface ExecutionDocument {version:1;runs:ExecutionRun[]}
const ownerId=(v:unknown):string=>{if(typeof v!=='string'||!/^[a-zA-Z0-9_-]{1,160}$/.test(v))throw Error('执行会话无效');return v}
const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b)
function validateRun(raw:ExecutionRun):ExecutionRun {
  const task=validateTaskRecord(raw.task),owner=ownerId(raw.owner)
  if(task.origin!=='executor'||!Array.isArray(raw.pending)||typeof raw.finished!=='boolean'||(raw.finished&&raw.pending.length))throw Error('执行日志格式无效')
  const all=validateTaskRecord({...task,endedAt:[task.endedAt,...raw.pending.map(c=>c.endedAt)].sort().at(-1),calls:[...task.calls,...raw.pending]})
  const pending=all.calls.slice(task.calls.length)
  if(pending.some(c=>c.usage!==null||c.cost!==null||c.startedAt!==c.endedAt))throw Error('待确认调用不能带结果')
  return {owner,task,pending,finished:raw.finished}
}
export function parseExecutionDocument(raw:string):ExecutionDocument {
  const doc=JSON.parse(raw)
  if(doc.version!==1||!Array.isArray(doc.runs)||doc.runs.length>10000)throw Error('执行日志容量或格式无效')
  const runs:ExecutionRun[]=doc.runs.map(validateRun),ids=new Set<string>(),calls=new Set<string>()
  for(const r of runs){const prefix=JSON.stringify([r.task.source,r.task.scopeId]),id=prefix+r.task.id;if(ids.has(id))throw Error('重复执行任务');ids.add(id)
    for(const c of [...r.task.calls,...r.pending]){const key=prefix+c.id;if(calls.has(key))throw Error('重复执行调用');calls.add(key)}}
  return {version:1,runs}
}
/** Write-ahead intent precedes any paid call. A repeated start is rejected, never permission to replay. */
export function applyExecutionEvent(doc:ExecutionDocument,input:unknown):ExecutionDocument {
  const e=input as ExecutionEvent;ownerId(e?.owner)
  const scope=validateHistoryScope('task' in e?e.task:e),taskId='task' in e?e.task.id:e.taskId
  const runs=structuredClone(doc.runs),run=runs.find(r=>sameScope(r.task,scope)&&r.task.id===taskId)
  if(e.kind==='begin'){
    const task=validateTaskRecord(e.task)
    if(run||task.calls.length||task.origin!=='executor')throw Error('任务已存在或开始状态无效；禁止自动重跑')
    runs.push({owner:e.owner,task,pending:[],finished:false})
  }else{
    if(!run||run.owner!==e.owner)throw Error('执行任务或会话不匹配')
    if(e.kind==='finish'){
      const task=validateTaskRecord(e.task)
      if(run.pending.length||!equal(task.calls,run.task.calls)||task.startedAt!==run.task.startedAt||task.label!==run.task.label||task.category!==run.task.category||task.origin!=='executor')throw Error('任务仍有未确认调用或记录冲突')
      if(run.finished&&!equal(task,run.task))throw Error('结束记录冲突')
      run.task=task;run.finished=true
    }else if(e.kind==='start'||e.kind==='complete'){
      if(run.finished)throw Error('任务已结束')
      const call=validateTaskRecord({...run.task,endedAt:[run.task.endedAt,e.call.endedAt].sort().at(-1),calls:[e.call]}).calls[0]
      const pending=run.pending.find(c=>c.id===call.id),prior=run.task.calls.find(c=>c.id===call.id)
      if(e.kind==='start'){
        if(pending||prior||run.task.calls.length+run.pending.length>=MAX_TASK_CALLS||call.usage!==null||call.cost!==null||call.startedAt!==call.endedAt)throw Error('重复调用或日志容量不足；禁止重跑')
        run.pending.push(call)
      }else{
        if(prior){if(!equal(prior,call))throw Error('完成调用冲突');return doc}
        if(!pending||!equal({...call,endedAt:pending.endedAt,status:pending.status,usage:null,cost:null},pending))throw Error('完成调用与发起记录不匹配')
        run.pending=run.pending.filter(c=>c.id!==call.id);run.task.calls.push(call)
        if(call.endedAt>run.task.endedAt)run.task.endedAt=call.endedAt
      }
    }else throw Error('未知执行操作')
  }
  return parseExecutionDocument(JSON.stringify({version:1,runs}))
}
