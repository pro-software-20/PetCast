import { iso, sameScope, validateHistoryScope, type HistoryScope } from './historySchema.js'
import { parseTaskDocument, pruneTasks, selectTasks, type TaskRecord } from './taskLedgerSchema.js'
export interface TaskEvaluation extends HistoryScope {
  id:string;taskId:string;createdAt:string;supersedes:string|null
  comparisonKey:string;rubricVersion:string;method:'user'|'rubric'
  verdict:'accepted'|'revise'|'unknown';note:string
}
export interface TaskLedgerDocument {version:2;tasks:TaskRecord[];evaluations:TaskEvaluation[]}
const text=(v:unknown,max=100)=>{if(typeof v!=='string'||!v.trim()||v.length>max||/[\u0000-\u001f]/.test(v))throw Error('评价文本无效');return v}
const id=(v:unknown)=>{const s=text(v,160);if(!/^[a-zA-Z0-9:._-]+$/.test(s))throw Error('评价 ID 无效');return s}
const taskKey=(t:HistoryScope,id:string)=>JSON.stringify([t.source,t.scopeId,id])
export function validateTaskEvaluation(input:unknown):TaskEvaluation {
  const v=input as TaskEvaluation,scope=validateHistoryScope(input)
  if(!['user','rubric'].includes(v.method)||!['accepted','revise','unknown'].includes(v.verdict)||typeof v.note!=='string'||v.note.length>500||/[\u0000-\u001f]/.test(v.note))throw Error('评价格式无效')
  return {...scope,id:id(v.id),taskId:id(v.taskId),createdAt:iso(v.createdAt),supersedes:v.supersedes===null?null:id(v.supersedes),comparisonKey:text(v.comparisonKey),rubricVersion:text(v.rubricVersion),method:v.method,verdict:v.verdict,note:v.note}
}
function checkedEvents(tasks:TaskRecord[],input:unknown,existing:TaskEvaluation[]=[],now?:number):TaskEvaluation[]{
  if(!Array.isArray(input)||input.length>100_000)throw Error('评价数量无效')
  const taskMap=new Map(tasks.map(t=>[taskKey(t,t.id),t])),latest=new Map<string,TaskEvaluation>(),ids=new Map<string,TaskEvaluation>(),counts=new Map<string,number>(),result:TaskEvaluation[]=[]
  for(const raw of [...existing,...input]){
    const e=validateTaskEvaluation(raw),k=taskKey(e,e.taskId),t=taskMap.get(k),eventKey=taskKey(e,e.id),prior=ids.get(eventKey)
    if(prior){if(JSON.stringify(prior)!==JSON.stringify(e))throw Error('评价 ID 冲突');continue}
    const last=latest.get(k)
    if(!t||e.createdAt<t.endedAt||(last&&e.createdAt<last.createdAt)||(now!==undefined&&Date.parse(e.createdAt)>now+300000))throw Error('评价任务关联或时间无效')
    if(e.supersedes!==(last?.id??null))throw Error('评价已更新，请刷新后重新提交')
    const count=(counts.get(k)??0)+1;if(count>50||result.length>=100_000)throw Error('评价容量已满')
    counts.set(k,count);latest.set(k,e);ids.set(eventKey,e);result.push(e)
  }
  return result
}
export function parseTaskLedgerDocument(raw:string):TaskLedgerDocument {
  const doc=JSON.parse(raw),tasks=parseTaskDocument(raw)
  if(doc.version===1&&doc.evaluations!==undefined)throw Error('旧账本不支持评价日志')
  return {version:2,tasks,evaluations:checkedEvents(tasks,doc.version===1?[]:doc.evaluations)}
}
export function pruneTaskLedger(doc:TaskLedgerDocument,now:number):TaskLedgerDocument {
  const tasks=pruneTasks(doc.tasks,now),ids=new Set(tasks.map(t=>taskKey(t,t.id)))
  return {version:2,tasks,evaluations:doc.evaluations.filter(e=>ids.has(taskKey(e,e.taskId)))}
}
export function appendTaskEvaluations(doc:TaskLedgerDocument,input:unknown,now=Date.now()):TaskLedgerDocument {
  if(!Array.isArray(input)||input.length>500)throw Error('每次最多写入 500 条评价')
  const current=pruneTaskLedger(doc,now)
  return {...current,evaluations:checkedEvents(current.tasks,input,current.evaluations,now)}
}
export function selectTaskEvaluations(doc:TaskLedgerDocument,query:unknown,now=Date.now()){
  const tasks=selectTasks(doc.tasks,query,now),ids=new Set(tasks.map(t=>taskKey(t,t.id)))
  return doc.evaluations.filter(e=>ids.has(taskKey(e,e.taskId))&&Date.parse(e.createdAt)<=now)
}
/** Derived view only: never write this overlay back as an immutable execution record. */
export function applyTaskEvaluations(tasks:TaskRecord[],events:TaskEvaluation[]):TaskRecord[]{
  const latest=new Map<string,TaskEvaluation>()
  for(const e of events){const k=taskKey(e,e.taskId),old=latest.get(k);if(!old||e.createdAt>=old.createdAt)latest.set(k,e)}
  return tasks.map(t=>{const e=latest.get(taskKey(t,t.id));if(!e)return t
    const {evaluation:_,...raw}=t
    return e.verdict==='unknown'?raw:{...raw,evaluation:{comparisonKey:e.comparisonKey,rubricVersion:e.rubricVersion,method:e.method,accepted:e.verdict==='accepted'}}
  })
}
export function clearTaskLedger(doc:TaskLedgerDocument,input:unknown,now:number){
  const scope=validateHistoryScope(input),current=pruneTaskLedger(doc,now)
  return {...current,tasks:current.tasks.filter(t=>!sameScope(t,scope)),evaluations:current.evaluations.filter(e=>!sameScope(e,scope))}
}
