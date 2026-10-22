import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { applyExecutionEvent, parseExecutionDocument, type ExecutionDocument } from './executionJournal.js'
import { sameScope, validateHistoryScope } from './historySchema.js'
export class FileExecutionJournal {
  private pending:Promise<unknown>=Promise.resolve()
  constructor(private file:string){}
  private serial<T>(action:()=>Promise<T>){const result=this.pending.then(action);this.pending=result.catch(()=>undefined);return result}
  private async read():Promise<ExecutionDocument>{try{if((await fs.stat(this.file)).size>64*1024*1024)throw Error('执行日志超过容量');return parseExecutionDocument(await fs.readFile(this.file,'utf8'))}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return {version:1,runs:[]};throw e}}
  writeExecutionEvent(input:unknown){const copy=structuredClone(input);return this.serial(async()=>{
    await this.write(applyExecutionEvent(await this.read(),copy))
  })}
  private async write(doc:ExecutionDocument){const raw=JSON.stringify(doc)
    if(Buffer.byteLength(raw)>64*1024*1024)throw Error('执行日志超过容量')
    await fs.mkdir(path.dirname(this.file),{recursive:true});const temp=this.file+'.'+randomUUID()+'.tmp'
    try{const handle=await fs.open(temp,'wx',0o600);try{await handle.writeFile(raw);await handle.sync()}finally{await handle.close()}await fs.rename(temp,this.file)}finally{await fs.unlink(temp).catch(()=>undefined)}
  }
  clearExecutions(input:unknown){const scope=validateHistoryScope(input);return this.serial(async()=>{const doc=await this.read();await this.write({...doc,runs:doc.runs.filter(r=>!sameScope(r.task,scope))})})}
  queryExecutions(input:unknown){const scope=validateHistoryScope(input);return this.serial(async()=>(await this.read()).runs.filter(r=>sameScope(r.task,scope)))}
}
