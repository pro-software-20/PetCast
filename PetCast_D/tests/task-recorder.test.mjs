import {test} from 'node:test'
import assert from 'node:assert/strict'
import {loadTs} from './load-ts.mjs'
const {TaskExecutionRecorder}=await loadTs('../src/history/TaskExecutionRecorder.ts')
const makeRecorder=(ledger,...args)=>new TaskExecutionRecorder({writeExecutionEvent:async()=>{},...ledger},...args)
const until=async fn=>{for(let i=0;i<100&&!fn();i++)await new Promise(r=>setImmediate(r));assert.ok(fn())}
const info={source:'mock',scopeId:'mock-local',id:'task1',label:'示意任务',category:'test'}
const call={id:'call1',provider:'test',model:'model',attempt:1}
const response={value:'result',usage:{inputTokens:100,outputTokens:20,cachedInputTokens:null,basis:'provider-reported'},cost:null}
test('executor adapter measures calls, associates task and records provider usage without output text',async()=>{
  let clock=Date.parse('2026-10-21T00:00:00.000Z'),saved=[]
  const run=makeRecorder({appendTaskRecords:async records=>{saved=records}},info,()=>clock)
  assert.equal(await run.call(call,async()=>{clock+=30000;return response}),'result')
  clock+=10000;await run.finish('succeeded')
  assert.equal(saved[0].calls[0].taskId,info.id);assert.equal(saved[0].calls[0].usage.inputTokens,100)
  assert.equal(Date.parse(saved[0].endedAt)-Date.parse(saved[0].startedAt),40000)
  assert.equal(JSON.stringify(saved).includes('result'),false)
})
test('failed calls retained; persistence retry does not run operation twice or change completion time',async()=>{
  let writes=0,operations=0
  const run=makeRecorder({appendTaskRecords:async()=>{if(++writes===1)throw Error('disk full')}},info)
  await assert.rejects(run.call(call,async()=>{operations++;throw Error('provider unavailable')}))
  await assert.rejects(run.finish('failed'));const first=run.snapshot()
  await run.finish('failed');assert.deepEqual(run.snapshot(),first);assert.equal(operations,1);assert.equal(first.calls[0].status,'failed');assert.equal(first.calls[0].usage,null)
})
test('metadata rejected before provider operation, active calls block finish and completed tasks cannot accept calls',async()=>{
  const run=makeRecorder({appendTaskRecords:async()=>{}},info);let ran=false,resolve
  await assert.rejects(run.call({...call,attempt:0},async()=>{ran=true;return response}));assert.equal(ran,false)
  const pending=run.call(call,()=>new Promise(r=>{resolve=r}));await assert.rejects(run.finish('succeeded'))
  await until(()=>resolve);resolve(response);await pending;await run.finish('succeeded')
  await assert.rejects(run.call({...call,id:'call2'},async()=>response))
})


test('records snapshot metadata and usage rather than retaining caller-owned objects',async()=>{
  const run=makeRecorder({appendTaskRecords:async()=>{}},info)
  const metadata={...call},usage={...response.usage},cost={amount:.1,currency:'USD',basis:'provider-reported'}
  let release
  const waiting=run.call(metadata,()=>new Promise(resolve=>{release=resolve}))
  metadata.model='changed';metadata.id='changed-id'
  await until(()=>release);release({value:'ok',usage,cost});await waiting
  usage.inputTokens=999;cost.amount=100
  await run.finish('succeeded')
  const saved=run.snapshot().calls[0]
  assert.equal(saved.model,'model');assert.equal(saved.id,'call1');assert.equal(saved.usage.inputTokens,100);assert.equal(saved.cost.amount,.1)
})

test('reserves the 1000-call record capacity before starting concurrent billable work',async()=>{
  const run=makeRecorder({appendTaskRecords:async()=>{}},info)
  let release,operations=0
  const gate=new Promise(resolve=>{release=resolve})
  const pending=Array.from({length:1000},(_,i)=>run.call({...call,id:`cap-${i}`},async()=>{operations++;await gate;return response}))
  const excess=run.call({...call,id:'excess'},async()=>{operations++;return response})
  release();await Promise.all(pending)
  await assert.rejects(excess,/1000/)
  assert.equal(operations,1000);await run.finish('succeeded');assert.equal(run.snapshot().calls.length,1000)
})

test('invalid provider measurement reports an adapter error without making the finished call unsavable',async()=>{
  const run=makeRecorder({appendTaskRecords:async()=>{}},info)
  await assert.rejects(run.call(call,async()=>({...response,usage:{...response.usage,inputTokens:-1}})),error=>error.code==='TASK_MEASUREMENT_INVALID')
  await run.finish('failed')
  assert.equal(run.snapshot().calls[0].status,'succeeded')
  assert.equal(run.snapshot().calls[0].usage,null)
})

test('persistence cannot mutate the final record retained for retries',async()=>{
  let writes=0
  const run=makeRecorder({appendTaskRecords:async rows=>{if(++writes===1){rows[0].label='changed';rows[0].calls.length=0;throw Error('disk full')}}},info)
  await run.call(call,async()=>response);await assert.rejects(run.finish('succeeded'))
  assert.equal(run.snapshot().label,info.label);assert.equal(run.snapshot().calls.length,1)
  await run.finish('succeeded')
})
