import { iso, sameScope, validateHistoryQuery, validateHistoryScope, type HistoryScope } from './historySchema.js'
export const MAX_TASK_CALLS = 1000
export interface CallRecord {
  id: string; taskId: string; provider: string; model: string
  startedAt: string; endedAt: string; status: 'succeeded'|'failed'; attempt: number
  usage: {inputTokens: number; outputTokens: number; cachedInputTokens: number|null; basis: 'provider-reported'}|null
  cost: {amount: number; currency: string; basis: 'provider-reported'|'price-estimate'; pricing?:{version:string;sourceUrl:string;effectiveAt:string}}|null
}
export interface TaskRecord extends HistoryScope {
  id: string; label: string; category: string; startedAt: string; endedAt: string
  status: 'succeeded'|'failed'|'cancelled'; origin: 'executor'|'import'
  evaluation?: {comparisonKey: string; accepted: boolean; method: 'user'|'rubric'; rubricVersion: string}
  calls: CallRecord[]
  quota: {provider: string; window: string; points: number; basis: 'exclusive-observation'}|null
}
const obj=(v: unknown): Record<string,unknown> => {if (!v || typeof v!=='object' || Array.isArray(v)) throw Error('任务记录格式无效');return v as Record<string,unknown>}
const text=(v: unknown,max=100) => {if(typeof v!=='string'||!v.trim()||v.length>max||/[\u0000-\u001f]/.test(v))throw Error('任务文本字段无效');return v}
const id=(v: unknown)=>{const s=text(v,160);if(!/^[a-zA-Z0-9:._-]+$/.test(s))throw Error('任务 ID 无效');return s}
const number=(v: unknown,integer=false)=>{if(typeof v!=='number'||!Number.isFinite(v)||v<0||v>1e12||(integer&&!Number.isSafeInteger(v)))throw Error('任务计量无效');return v}
export function validateTaskRecord(input: unknown): TaskRecord {
  const v=obj(input), scope=validateHistoryScope(v), taskId=id(v.id), startedAt=iso(v.startedAt), endedAt=iso(v.endedAt)
  if(endedAt<startedAt || Date.parse(endedAt)-Date.parse(startedAt)>366*86400_000)throw Error('任务时间无效')
  if(!['succeeded','failed','cancelled'].includes(String(v.status)) || !['executor','import'].includes(String(v.origin)))throw Error('任务状态无效')
  if(!Array.isArray(v.calls)||v.calls.length>MAX_TASK_CALLS)throw Error('调用记录无效')
  const ids=new Set<string>()
  const calls=v.calls.map(input=>{
    const c=obj(input), callId=id(c.id), start=iso(c.startedAt),end=iso(c.endedAt)
    if(c.taskId!==taskId || ids.has(callId)||start<startedAt||end>endedAt||end<start)throw Error('调用与任务关联或时间无效')
    ids.add(callId)
    if(c.status!=='succeeded'&&c.status!=='failed')throw Error('调用状态无效')
    const attempt=number(c.attempt,true);if(attempt<1)throw Error('调用次数无效')
    let usage: CallRecord['usage']=null, cost: CallRecord['cost']=null
    if(c.usage!==null){const u=obj(c.usage);if(u.basis!=='provider-reported')throw Error('仅接受服务商上报 Token');const inputTokens=number(u.inputTokens,true),outputTokens=number(u.outputTokens,true),cachedInputTokens=u.cachedInputTokens===null?null:number(u.cachedInputTokens,true);if(cachedInputTokens!==null&&cachedInputTokens>inputTokens)throw Error('缓存 Token 不能超过输入');usage={inputTokens,outputTokens,cachedInputTokens,basis:'provider-reported'}}
    if(c.cost!==null){const p=obj(c.cost);if(p.basis!=='provider-reported'&&p.basis!=='price-estimate')throw Error('成本依据无效');const currency=text(p.currency,3);if(!/^[A-Z]{3}$/.test(currency))throw Error('币种无效');cost={amount:number(p.amount),currency,basis:p.basis};if(p.pricing!==undefined){const pricing=obj(p.pricing),sourceUrl=text(pricing.sourceUrl,1000);let url:URL;try{url=new URL(sourceUrl)}catch{throw Error('价格来源无效')}if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw Error('价格来源无效');cost.pricing={version:text(pricing.version),sourceUrl,effectiveAt:iso(pricing.effectiveAt)};if(cost.pricing.effectiveAt>start)throw Error('价格在调用时尚未生效')}}
    return {id:callId,taskId,provider:text(c.provider),model:text(c.model),startedAt:start,endedAt:end,status:c.status,attempt,usage,cost} as CallRecord
  })
  let quota: TaskRecord['quota']=null
  if(v.quota!==null){const q=obj(v.quota);if(q.basis!=='exclusive-observation')throw Error('任务额度必须来自独占观测');quota={provider:text(q.provider),window:text(q.window),points:number(q.points),basis:q.basis}}
  let evaluation: TaskRecord['evaluation']
  if(v.evaluation!==undefined){const e=obj(v.evaluation);if(typeof e.accepted!=='boolean'||(e.method!=='user'&&e.method!=='rubric'))throw Error('任务评价无效');evaluation={comparisonKey:text(e.comparisonKey),accepted:e.accepted,method:e.method,rubricVersion:text(e.rubricVersion)}}
  return {...(evaluation?{evaluation}:{}),...scope,id:taskId,label:text(v.label),category:text(v.category),startedAt,endedAt,status:v.status as TaskRecord['status'],origin:v.origin as TaskRecord['origin'],calls,quota}
}
export function parseTaskDocument(raw: string): TaskRecord[] {
  const v=obj(JSON.parse(raw));if((v.version!==1&&v.version!==2)||!Array.isArray(v.tasks)||v.tasks.length>100_000)throw Error('任务文件格式无效')
  const tasks=v.tasks.map(validateTaskRecord), taskIds=new Set<string>(), callIds=new Set<string>()
  for(const t of tasks){const prefix=t.source+':'+t.scopeId+':';if(taskIds.has(prefix+t.id))throw Error('重复任务记录');taskIds.add(prefix+t.id);for(const c of t.calls){if(callIds.has(prefix+c.id))throw Error('重复调用记录');callIds.add(prefix+c.id)}}
  return tasks
}
export function pruneTasks(tasks: TaskRecord[],now=Date.now()) {
  const groups=new Map<string,TaskRecord[]>()
  for(const t of tasks) {if(Date.parse(t.endedAt)<now-180*86400_000)continue;const key=t.source+':'+t.scopeId;const group=groups.get(key)??[];group.push(t);groups.set(key,group)}
  return [...groups.values()].flatMap(g=>g.sort((a,b)=>a.endedAt.localeCompare(b.endedAt)).slice(-10_000))
}
export function appendTasks(existing: TaskRecord[], input: unknown,now=Date.now()) {
  if(!Array.isArray(input)||input.length>500)throw Error('每次最多写入 500 个任务')
  const tasks=pruneTasks(existing,now)
  for(const v of input){const t=validateTaskRecord(v);if(Date.parse(t.endedAt)>now+300_000)throw Error('任务结束时间超前');const previous=tasks.find(p=>sameScope(p,t)&&p.id===t.id);if(previous){if(JSON.stringify(previous)!==JSON.stringify(t))throw Error('任务 ID 冲突，原记录已保留');continue}
    if(t.calls.some(c=>tasks.some(p=>sameScope(p,t)&&p.calls.some(old=>old.id===c.id))))throw Error('调用 ID 已属于其他任务')
    tasks.push(t)
  }
  return pruneTasks(tasks,now)
}
export function selectTasks(tasks: TaskRecord[],input: unknown,now=Date.now()) {
  const q=validateHistoryQuery(input)
  return pruneTasks(tasks,now).filter(t=>sameScope(t,q)&&t.endedAt>=q.startAt&&t.endedAt<q.endAt)
}
