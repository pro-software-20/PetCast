import type { ExecutionEvent } from './executionJournal.js'
import { FileExecutionJournal } from './executionJournalStore.js'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { parseTaskLedgerDocument, pruneTaskLedger, appendTaskEvaluations, selectTaskEvaluations, clearTaskLedger, type TaskLedgerDocument } from './taskEvaluations.js'
import { appendTasks, parseTaskDocument, pruneTasks, selectTasks, type TaskRecord } from './taskLedgerSchema.js'
export class FileTaskLedger {
  private pending: Promise<unknown>=Promise.resolve()
  private journal:FileExecutionJournal
  constructor(private readonly file: string,private readonly now=Date.now){this.journal=new FileExecutionJournal(file+'.executions.json')}
  writeExecutionEvent(input:unknown){const copy=structuredClone(input);return this.serial(async()=>{const e=copy as ExecutionEvent;if(e.kind==='begin'&&(await this.read()).tasks.some(t=>t.source===e.task?.source&&t.scopeId===e.task?.scopeId&&t.id===e.task?.id))throw Error('任务已完成，禁止重复执行');if(e.kind==='start'&&(await this.read()).tasks.some(t=>t.source===e.source&&t.scopeId===e.scopeId&&t.calls.some(c=>c.id===e.call.id)))throw Error('调用已存在于完成账本，禁止重复执行');await this.journal.writeExecutionEvent(copy)})}
  queryExecutions(scope:unknown){return this.journal.queryExecutions(scope)}
  async reconcileExecutions(scope:unknown){const runs=await this.journal.queryExecutions(scope);for(const run of runs)if(run.finished)await this.appendTaskRecords([run.task])}
  private serial<T>(action:()=>Promise<T>){const result=this.pending.then(action);this.pending=result.catch(()=>undefined);return result}
  private async read(){try{if((await fs.stat(this.file)).size>64*1024*1024)throw Error('任务文件过大');return parseTaskLedgerDocument(await fs.readFile(this.file,'utf8'))}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return {version:2 as const,tasks:[],evaluations:[]};throw Error('任务文件读取失败，原数据保留')}}
  private async write(doc:TaskLedgerDocument){if(doc.tasks.length>100_000)throw Error('任务总条数超过容量');const raw=JSON.stringify(doc);if(Buffer.byteLength(raw)>64*1024*1024)throw Error('任务记录超过容量');await fs.mkdir(path.dirname(this.file),{recursive:true});const temp=this.file+'.'+randomUUID()+'.tmp';try{await fs.writeFile(temp,raw,{flag:'wx',mode:0o600});await fs.rename(temp,this.file)}finally{await fs.unlink(temp).catch(()=>undefined)}}
  appendTaskRecords(input:unknown){return this.serial(async()=>{const doc=await this.read();await this.write(pruneTaskLedger({...doc,tasks:appendTasks(doc.tasks,input,this.now())},this.now()))})}
  queryTaskRecords(input:unknown){return this.serial(async()=>selectTasks((await this.read()).tasks,input,this.now()))}
  appendTaskEvaluations(input:unknown){return this.serial(async()=>this.write(appendTaskEvaluations(await this.read(),input,this.now())))}
  queryTaskEvaluations(input:unknown){return this.serial(async()=>selectTaskEvaluations(await this.read(),input,this.now()))}
  clearTaskRecords(input:unknown){return this.serial(async()=>{const cleared=clearTaskLedger(await this.read(),input,this.now());await this.journal.clearExecutions(input);await this.write(cleared)})}
}
