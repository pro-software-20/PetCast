import { applyExecutionEvent, parseExecutionDocument, type ExecutionEvent, type ExecutionRun } from '../../electron/executionJournal'
import { parseTaskLedgerDocument, pruneTaskLedger, appendTaskEvaluations, selectTaskEvaluations, clearTaskLedger, validateTaskEvaluation, type TaskEvaluation } from '../../electron/taskEvaluations'
export type {TaskEvaluation} from '../../electron/taskEvaluations'
import { appendTasks, parseTaskDocument, selectTasks, validateTaskRecord, type TaskRecord } from '../../electron/taskLedgerSchema'
import { sameScope, validateHistoryQuery, validateHistoryScope, type HistoryQuery, type HistoryScope } from '../../electron/historySchema'
export type {TaskRecord, CallRecord} from '../../electron/taskLedgerSchema'
export interface TaskLedger {
  writeExecutionEvent(event:ExecutionEvent):Promise<void>
  queryExecutions(scope:HistoryScope):Promise<ExecutionRun[]>
  reconcileExecutions(scope:HistoryScope):Promise<void>
  appendTaskEvaluations(events:TaskEvaluation[]):Promise<void>
  queryTaskEvaluations(query:HistoryQuery):Promise<TaskEvaluation[]>
  appendTaskRecords(tasks: TaskRecord[]): Promise<void>
  queryTaskRecords(query: HistoryQuery): Promise<TaskRecord[]>
  clearTaskRecords(scope: HistoryScope): Promise<void>
}
export interface TaskLedgerBridge {
  writeExecutionEvent?: (event:ExecutionEvent)=>Promise<{ok:boolean}>
  queryExecutions?: (scope:HistoryScope)=>Promise<{ok:boolean;data?:unknown}>
  reconcileExecutions?: (scope:HistoryScope)=>Promise<{ok:boolean}>
  appendTaskEvaluations?: (events:TaskEvaluation[])=>Promise<{ok:boolean}>
  queryTaskEvaluations?: (query:HistoryQuery)=>Promise<{ok:boolean;data?:unknown}>
  appendTaskRecords?: (tasks: TaskRecord[])=>Promise<{ok:boolean}>
  queryTaskRecords?: (query: HistoryQuery)=>Promise<{ok:boolean; data?:unknown}>
  clearTaskRecords?: (scope: HistoryScope)=>Promise<{ok:boolean}>
}
const notifyChanged=()=>{if(typeof window!=='undefined')window.dispatchEvent(new Event('petcast:task-ledger-changed'))}
export const TASK_LEDGER_KEY='petcast.task-ledger.v1'
export const EXECUTION_JOURNAL_KEY=TASK_LEDGER_KEY+'.executions'
export class BrowserTaskLedger implements TaskLedger {
  private pending:Promise<unknown>=Promise.resolve()
  constructor(private storage:Pick<Storage,'getItem'|'setItem'>,private now=Date.now){}
  private serial<T>(action:()=>T){const run=()=>typeof window!=='undefined'&&typeof navigator!=='undefined'&&navigator.locks?navigator.locks.request(TASK_LEDGER_KEY,action):Promise.resolve().then(action);const result=this.pending.then(run);this.pending=result.catch(()=>undefined);return result}
  private readExecutions(){const raw=this.storage.getItem(EXECUTION_JOURNAL_KEY);return raw===null?{version:1 as const,runs:[]}:parseExecutionDocument(raw)}
  writeExecutionEvent(event:ExecutionEvent){const copy=structuredClone(event);return this.serial(()=>{if(copy.kind==='begin'&&this.read().tasks.some(t=>sameScope(t,copy.task)&&t.id===copy.task.id))throw Error('任务已完成，禁止重复执行');if(copy.kind==='start'&&this.read().tasks.some(t=>sameScope(t,copy)&&t.calls.some(c=>c.id===copy.call.id)))throw Error('调用已存在于完成账本，禁止重复执行');this.storage.setItem(EXECUTION_JOURNAL_KEY,JSON.stringify(applyExecutionEvent(this.readExecutions(),copy)))}).then(notifyChanged)}
  queryExecutions(scope:HistoryScope){const checked=validateHistoryScope(scope);return this.serial(()=>this.readExecutions().runs.filter(r=>sameScope(r.task,checked)))}
  async reconcileExecutions(scope:HistoryScope){for(const run of await this.queryExecutions(scope))if(run.finished)await this.appendTaskRecords([run.task])}
  private read(){const raw=this.storage.getItem(TASK_LEDGER_KEY);return raw===null?{version:2 as const,tasks:[],evaluations:[]}:parseTaskLedgerDocument(raw)}
  appendTaskRecords(tasks:TaskRecord[]){const copy=tasks.map(validateTaskRecord);return this.serial(()=>{const doc=this.read();this.storage.setItem(TASK_LEDGER_KEY,JSON.stringify(pruneTaskLedger({...doc,tasks:appendTasks(doc.tasks,copy,this.now())},this.now()))) }).then(notifyChanged)}
  queryTaskRecords(query:HistoryQuery){return this.serial(()=>selectTasks(this.read().tasks,query,this.now()))}
  appendTaskEvaluations(events:TaskEvaluation[]){const copy=events.map(validateTaskEvaluation);return this.serial(()=>this.storage.setItem(TASK_LEDGER_KEY,JSON.stringify(appendTaskEvaluations(this.read(),copy,this.now())))).then(notifyChanged)}
  queryTaskEvaluations(query:HistoryQuery){return this.serial(()=>selectTaskEvaluations(this.read(),query,this.now()))}
  clearTaskRecords(scope:HistoryScope){return this.serial(()=>{const cleared=clearTaskLedger(this.read(),scope,this.now()),runs=this.readExecutions().runs.filter(r=>!sameScope(r.task,scope));this.storage.setItem(EXECUTION_JOURNAL_KEY,JSON.stringify({version:1,runs}));this.storage.setItem(TASK_LEDGER_KEY,JSON.stringify(cleared))}).then(notifyChanged)}
}
export class DesktopTaskLedger implements TaskLedger {
  constructor(private bridge:TaskLedgerBridge){}
  async writeExecutionEvent(event:ExecutionEvent){if(!this.bridge.writeExecutionEvent||!(await this.bridge.writeExecutionEvent(event))?.ok)throw Error('执行日志保存失败');notifyChanged()}
  async queryExecutions(scope:HistoryScope){if(!this.bridge.queryExecutions)throw Error('执行日志接口未接入');const r=await this.bridge.queryExecutions(validateHistoryScope(scope));if(!r?.ok||!Array.isArray(r.data))throw Error('执行日志读取失败');return parseExecutionDocument(JSON.stringify({version:1,runs:r.data})).runs.filter(run=>sameScope(run.task,scope))}
  async reconcileExecutions(scope:HistoryScope){if(!this.bridge.reconcileExecutions||!(await this.bridge.reconcileExecutions(validateHistoryScope(scope)))?.ok)throw Error('补存失败，请检查原记录是否冲突');notifyChanged()}
  async appendTaskRecords(tasks:TaskRecord[]){if(!this.bridge.appendTaskRecords||!(await this.bridge.appendTaskRecords(tasks.map(validateTaskRecord)))?.ok)throw Error('任务记录保存失败');notifyChanged()}
  async queryTaskRecords(query:HistoryQuery){if(!this.bridge.queryTaskRecords)throw Error('任务接口未接入');const r=await this.bridge.queryTaskRecords(validateHistoryQuery(query));if(!r?.ok||!Array.isArray(r.data))throw Error('任务记录读取失败');return r.data.map(validateTaskRecord)}
  async appendTaskEvaluations(events:TaskEvaluation[]){if(!this.bridge.appendTaskEvaluations||!(await this.bridge.appendTaskEvaluations(events.map(validateTaskEvaluation)))?.ok)throw Error('评价保存失败，请刷新后重试');notifyChanged()}
  async queryTaskEvaluations(query:HistoryQuery){if(!this.bridge.queryTaskEvaluations)throw Error('评价接口未接入');const r=await this.bridge.queryTaskEvaluations(validateHistoryQuery(query));if(!r?.ok||!Array.isArray(r.data))throw Error('评价读取失败');return r.data.map(validateTaskEvaluation)}
  async clearTaskRecords(scope:HistoryScope){if(!this.bridge.clearTaskRecords||!(await this.bridge.clearTaskRecords(validateHistoryScope(scope)))?.ok)throw Error('任务记录清除失败');notifyChanged()}
}
export function createTaskLedger(bridge?:TaskLedgerBridge):TaskLedger {return bridge?new DesktopTaskLedger(bridge):new BrowserTaskLedger({getItem:k=>localStorage.getItem(k),setItem:(k,v)=>localStorage.setItem(k,v)})}
/** Executor boundary: await this after final task state, keep a retry queue on persistence failure. */
export async function recordCompletedTask(ledger:TaskLedger,task:TaskRecord){await ledger.appendTaskRecords([validateTaskRecord(task)])}
