import { type TaskLedger, type TaskRecord, type CallRecord } from './TaskLedger'
import type { ExecutionEvent } from '../../electron/executionJournal'
import { validateTaskRecord, MAX_TASK_CALLS } from '../../electron/taskLedgerSchema'
/** The provider completed, but its adapter returned invalid metering. Do not retry the paid call. */
export class TaskMeasurementError extends Error {
  readonly code='TASK_MEASUREMENT_INVALID'
  constructor(){super('调用已完成，但计量数据无效；已保留调用并将计量标为未知。请修正适配器，不要自动重试原调用。');this.name='TaskMeasurementError'}
}
export class TaskPersistenceError extends Error {
  readonly code='TASK_PERSISTENCE_FAILED'
  constructor(readonly mayHaveExecuted:boolean){super(mayHaveExecuted?'调用可能已计费，日志保存失败；只重试 flush / finish，不要重跑调用。':'调用尚未发起，执行日志保存失败；请先检查存储。');this.name='TaskPersistenceError'}
}
/** Wrap actual provider calls. No prompt/result text or account credentials enter the ledger. */
export class TaskExecutionRecorder {
  private task: TaskRecord
  private active=0
  private final=false
  private ids=new Set<string>()
  private owner=globalThis.crypto.randomUUID()
  private begun:Promise<void>|undefined
  private unsaved:ExecutionEvent[]=[]
  private blocked=false
  private flushing:Promise<void>|undefined
  private begin(){return this.begun??=this.ledger.writeExecutionEvent({kind:'begin',owner:this.owner,task:structuredClone(this.task)})}
  /** Retry persistence only. Never invokes a model, including after ambiguous write failures. */
  async flush():Promise<void>{
    if(this.flushing){await this.flushing;if(this.unsaved.length)return this.flush();return}
    this.flushing=(async()=>{while(this.unsaved.length){await this.ledger.writeExecutionEvent(structuredClone(this.unsaved[0]));this.unsaved.shift()}this.blocked=false})()
    try{await this.flushing}finally{this.flushing=undefined}
  }
  constructor(private ledger:TaskLedger, info:Pick<TaskRecord,'source'|'scopeId'|'id'|'label'|'category'>,private now=Date.now){
    const at=new Date(now()).toISOString()
    this.task=validateTaskRecord({...info,startedAt:at,endedAt:at,status:'succeeded',origin:'executor',calls:[],quota:null})
  }
  async call<T>(info:Pick<CallRecord,'id'|'provider'|'model'|'attempt'>,operation:()=>Promise<{value:T;usage:CallRecord['usage'];cost:CallRecord['cost']}>):Promise<T>{
    if(this.blocked)throw new TaskPersistenceError(true)
    if(this.final||this.ids.has(info.id))throw Error('任务已结束或调用 ID 重复')
    if(this.ids.size>=MAX_TASK_CALLS)throw Error(`每任务最多 ${MAX_TASK_CALLS} 次调用，请先结束并保存当前任务`)
    const at=new Date(this.now()).toISOString()
    // Validate metadata before starting a potentially billable operation.
    const metadata=validateTaskRecord({...this.task,endedAt:at,calls:[{...info,taskId:this.task.id,startedAt:at,endedAt:at,status:'succeeded',usage:null,cost:null}]}).calls[0]
    this.ids.add(metadata.id);this.active++
    try{await this.begin();await this.ledger.writeExecutionEvent({kind:'start',owner:this.owner,source:this.task.source,scopeId:this.task.scopeId,taskId:this.task.id,call:metadata})}catch{this.active--;this.blocked=true;throw new TaskPersistenceError(false)}
    let usage:CallRecord['usage']=null,cost:CallRecord['cost']=null,status:CallRecord['status']='failed'
    try{
      const response=await operation();status='succeeded'
      // Validate and copy at the boundary; caller mutation must not change accounting later.
      try{
        const measured=validateTaskRecord({...this.task,endedAt:at,calls:[{...metadata,usage:response.usage,cost:response.cost}]}).calls[0]
        usage=measured.usage;cost=measured.cost
      }catch{throw new TaskMeasurementError()}
      return response.value
    }
    finally{
      const end=new Date(Math.max(Date.parse(at),this.now())).toISOString()
      const completed={...metadata,endedAt:end,status,usage,cost}
      this.task.calls.push(completed)
      this.unsaved.push({kind:'complete',owner:this.owner,source:this.task.source,scopeId:this.task.scopeId,taskId:this.task.id,call:completed})
      try{await this.flush()}catch{this.blocked=true;throw new TaskPersistenceError(true)}finally{this.active--}
    }
  }
  /** Retains the same final record after storage failure; retry finish() without re-running calls. */
  async finish(status:TaskRecord['status'],quota:TaskRecord['quota']=null,evaluation?:TaskRecord['evaluation']){
    if(this.active)throw Error('仍有调用未完成')
    await this.begin();await this.flush()
    if(!this.final){
      const last=Math.max(Date.parse(this.task.startedAt),...this.task.calls.map(c=>Date.parse(c.endedAt)))
      const record=validateTaskRecord({...this.task,...(evaluation?{evaluation}:{}),status,quota,endedAt:new Date(Math.max(last,this.now())).toISOString()})
      this.task=record;this.final=true
    }
    await this.ledger.writeExecutionEvent({kind:'finish',owner:this.owner,task:structuredClone(this.task)})
    await this.ledger.appendTaskRecords([structuredClone(this.task)])
  }
  snapshot(){return structuredClone(this.task)}
}
