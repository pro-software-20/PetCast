import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {loadTs} from './load-ts.mjs'
const {TaskExecutionRecorder}=await loadTs('../src/history/TaskExecutionRecorder.ts')
const {FileTaskLedger}=await loadTs('../electron/taskLedgerStore.ts')
const {BrowserTaskLedger,EXECUTION_JOURNAL_KEY}=await loadTs('../src/history/TaskLedger.ts')
const scope={source:'mock',scopeId:'mock-recovery'},info={...scope,id:'task',label:'恢复验收',category:'test'}
const call={id:'call',provider:'fixture',model:'tested',attempt:1}
const response={value:'private output',usage:{inputTokens:20,outputTokens:10,cachedInputTokens:0,basis:'provider-reported'},cost:{amount:.01,currency:'USD',basis:'provider-reported'}}
const query={...scope,startAt:'2026-01-01T00:00:00.000Z',endAt:'2027-01-01T00:00:00.000Z'}
const clock=()=>Date.parse('2026-10-22T01:00:00.000Z')
async function fixture(kind){if(kind==='file'){const file=path.join(await mkdtemp(path.join(tmpdir(),'petcast-recovery-')),'tasks.json');return {ledger:new FileTaskLedger(file,clock),reopen:()=>new FileTaskLedger(file,clock),file}}
  const data=new Map(),storage={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v)};return {ledger:new BrowserTaskLedger(storage,clock),reopen:()=>new BrowserTaskLedger(storage,clock),data}}
for(const kind of ['file','browser']){
  test(`${kind}: intent is durable before provider, completed calls survive recorder loss`,async()=>{
    const f=await fixture(kind),run=new TaskExecutionRecorder(f.ledger,info,clock)
    await run.call(call,async()=>{const [saved]=await f.reopen().queryExecutions(scope);assert.equal(saved.pending.length,1);assert.equal(saved.task.calls.length,0);return response})
    const [saved]=await f.reopen().queryExecutions(scope)
    assert.equal(saved.task.calls[0].cost.amount,.01);assert.equal(saved.pending.length,0);assert.equal(saved.finished,false)
    assert.equal(JSON.stringify(saved).includes('private output'),false)
    assert.equal((await f.reopen().queryTaskRecords(query)).length,0)
    let operations=0
    await assert.rejects(new TaskExecutionRecorder(f.reopen(),info,clock).call(call,async()=>{operations++;return response}))
    assert.equal(operations,0);assert.equal((await f.reopen().queryExecutions({...scope,scopeId:'mock-other'})).length,0)
  })
  test(`${kind}: final journal recovers missing report record idempotently without paid operations`,async()=>{
    const f=await fixture(kind),ledger=f.ledger;let operations=0
    const failedLedger={writeExecutionEvent:e=>ledger.writeExecutionEvent(e),appendTaskRecords:async()=>{throw Error('disk unavailable')}}
    const run=new TaskExecutionRecorder(failedLedger,info,clock)
    await run.call(call,async()=>{operations++;return response});await assert.rejects(run.finish('succeeded'))
    assert.equal((await ledger.queryExecutions(scope))[0].finished,true)
    await f.reopen().reconcileExecutions(scope);await f.reopen().reconcileExecutions(scope)
    assert.equal((await ledger.queryTaskRecords(query)).length,1);assert.equal(operations,1)
  })
  test(`${kind}: repeated starts, foreign owners and premature finish cannot erase uncertain calls`,async()=>{
    const f=await fixture(kind),at=new Date(clock()).toISOString(),task={...info,startedAt:at,endedAt:at,status:'succeeded',origin:'executor',calls:[],quota:null},owner='owner'
    const start={kind:'start',owner,...scope,taskId:info.id,call:{...call,taskId:info.id,startedAt:at,endedAt:at,status:'succeeded',usage:null,cost:null}}
    await f.ledger.writeExecutionEvent({kind:'begin',owner,task});await f.ledger.writeExecutionEvent(start)
    await assert.rejects(f.ledger.writeExecutionEvent(start));await assert.rejects(f.ledger.writeExecutionEvent({...start,owner:'foreign'}))
    await assert.rejects(f.ledger.writeExecutionEvent({kind:'finish',owner,task}))
    const [saved]=await f.reopen().queryExecutions(scope);assert.equal(saved.pending.length,1);assert.equal(saved.pending[0].cost,null)
  })
  test(`${kind}: scoped clear removes recovery copies without affecting other accounts`,async()=>{
    const f=await fixture(kind)
    for(const scopeId of [scope.scopeId,'mock-other']){const run=new TaskExecutionRecorder(f.ledger,{...info,scopeId},clock);await run.call(call,async()=>response);await run.finish('succeeded')}
    await f.ledger.clearTaskRecords(scope);assert.equal((await f.ledger.queryExecutions(scope)).length,0)
    await f.ledger.reconcileExecutions(scope);assert.equal((await f.ledger.queryTaskRecords(query)).length,0)
    assert.equal((await f.ledger.queryExecutions({...scope,scopeId:'mock-other'})).length,1)
  })
  test(`${kind}: imported historical call IDs cannot authorize a second paid execution`,async()=>{
    const f=await fixture(kind),at=new Date(clock()).toISOString()
    await f.ledger.appendTaskRecords([{...info,id:'imported',origin:'import',status:'succeeded',startedAt:at,endedAt:at,quota:null,calls:[{...call,taskId:'imported',status:'succeeded',startedAt:at,endedAt:at,usage:response.usage,cost:response.cost}]}])
    let operations=0;const run=new TaskExecutionRecorder(f.ledger,info,clock)
    await assert.rejects(run.call(call,async()=>{operations++;return response}));assert.equal(operations,0)
  })
}
test('persistence failures stop calls; flush retries data only and preserves completed measurement',async()=>{
  const {ledger}=await fixture('browser');let fail=true,operations=0
  const wrapper={writeExecutionEvent:async e=>{if(e.kind==='complete'&&fail)throw Error('quota full');return ledger.writeExecutionEvent(e)},appendTaskRecords:t=>ledger.appendTaskRecords(t)}
  const run=new TaskExecutionRecorder(wrapper,info,clock)
  await assert.rejects(run.call(call,async()=>{operations++;return response}),e=>e.code==='TASK_PERSISTENCE_FAILED'&&e.mayHaveExecuted)
  await assert.rejects(run.call({...call,id:'second'},async()=>{operations++;return response}))
  assert.equal((await ledger.queryExecutions(scope))[0].pending.length,1)
  fail=false;await run.flush();await run.finish('succeeded')
  assert.equal(operations,1);assert.equal((await ledger.queryTaskRecords(query))[0].calls[0].cost.amount,.01)
})
test('journal failure before invocation blocks spending and legacy adapters fail closed',async()=>{
  let operations=0;const run=new TaskExecutionRecorder({appendTaskRecords:async()=>{}},info,clock)
  await assert.rejects(run.call(call,async()=>{operations++;return response}),e=>e.code==='TASK_PERSISTENCE_FAILED'&&!e.mayHaveExecuted)
  assert.equal(operations,0)
})
test('concurrent provider completions retain all journal records and finish order',async()=>{
  const {ledger}=await fixture('browser'),run=new TaskExecutionRecorder(ledger,info,clock)
  await Promise.all(Array.from({length:20},(_,i)=>run.call({...call,id:`call-${i}`},async()=>{await new Promise(r=>setTimeout(r,(20-i)%5));return response})))
  await run.finish('succeeded');const [saved]=await ledger.queryExecutions(scope)
  assert.equal(saved.task.calls.length,20);assert.deepEqual(saved.task.calls,run.snapshot().calls)
})
test('corrupt journal is preserved and prevents new calls',async()=>{
  const {file,ledger}=await fixture('file');await writeFile(file+'.executions.json','broken')
  let operations=0;const run=new TaskExecutionRecorder(ledger,info,clock)
  await assert.rejects(run.call(call,async()=>{operations++;return response}));assert.equal(operations,0)
  assert.equal(await readFile(file+'.executions.json','utf8'),'broken')
})
