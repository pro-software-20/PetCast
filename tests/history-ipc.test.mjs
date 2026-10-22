import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'
const require=createRequire(import.meta.url)
const compiled=ts.transpileModule(await readFile(new URL('../electron/historyIpc.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText
function setup(fail=false){
  const handlers=new Map(),calls=[],exports={}
  const frame={url:'file:///test/index.html'},sender={mainFrame:frame}
  vm.runInNewContext(compiled,{exports,URL,require(name){
    if(name==='electron')return {ipcMain:{handle:(key,fn)=>handlers.set(key,fn)}}
    if(name==='./historyStore.js')return {FileUsageHistoryStore:class {
      appendUsageSample(input){calls.push(input);if(fail)throw Error('secret details');return Promise.resolve()}
      queryUsageSamples(input){return this.appendUsageSample(input).then(()=>[])}
      clearUsageHistory(input){return this.appendUsageSample(input)}
    }}
    if(name==='./taskLedgerStore.js')return {FileTaskLedger:class {
      appendTaskRecords(input){calls.push(input);if(fail)throw Error('secret details');return Promise.resolve()}
      queryTaskRecords(input){return this.appendTaskRecords(input).then(()=>[])}
      clearTaskRecords(input){return this.appendTaskRecords(input)}
      writeExecutionEvent(input){return this.appendTaskRecords(input)}
      queryExecutions(input){return this.appendTaskRecords(input).then(()=>[])}
      reconcileExecutions(input){return this.appendTaskRecords(input)}
      appendTaskEvaluations(input){return this.appendTaskRecords(input)}
      queryTaskEvaluations(input){return this.appendTaskRecords(input).then(()=>[])}
    }}
    return require(name)
  }})
  exports.registerUsageHistoryIpc(()=>({isDestroyed:()=>false,webContents:sender}),'/test',frame.url)
  return {calls,frame,sender,invoke:(key,input,event={sender,senderFrame:frame})=>handlers.get(key)(event,input)}
}
test('history IPC rejects wrong sender, subframes and a navigated document before touching storage',async()=>{
  const h=setup()
  for(const channel of ['history:append','history:query','history:clear','tasks:append','tasks:query','tasks:clear','tasks:evaluate','tasks:evaluations','tasks:execution-write','tasks:executions','tasks:reconcile']){
    assert.equal((await h.invoke(channel,{}, {sender:{},senderFrame:h.frame})).ok,false)
    assert.equal((await h.invoke(channel,{}, {sender:h.sender,senderFrame:{url:h.frame.url}})).ok,false)
  }
  h.frame.url='https://example.invalid/index.html'
  assert.equal((await h.invoke('history:query',{})).ok,false)
  assert.equal(h.calls.length,0)
})
test('history IPC forwards allowed calls and sanitizes storage errors',async()=>{
  const h=setup();assert.equal((await h.invoke('history:query',{})).ok,true)
  assert.equal((await h.invoke('tasks:query',{})).ok,true)
  assert.equal((await h.invoke('tasks:evaluate',{})).ok,true)
  assert.equal((await h.invoke('tasks:evaluations',{})).ok,true)
  for(const channel of ['tasks:execution-write','tasks:executions','tasks:reconcile'])assert.equal((await h.invoke(channel,{})).ok,true)
  assert.equal((await setup(true).invoke('tasks:append',{})).ok,false)
  const bad=await setup(true).invoke('history:append',{})
  assert.equal(bad.ok,false);assert.equal(bad.error.includes('secret'),false)
})
