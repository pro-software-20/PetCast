import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {loadTs} from './load-ts.mjs'
const {FileTaskLedger}=await loadTs('../electron/taskLedgerStore.ts')
const {BrowserTaskLedger,DesktopTaskLedger,TASK_LEDGER_KEY}=await loadTs('../src/history/TaskLedger.ts')
const {validateTaskRecord,appendTasks}=await loadTs('../electron/taskLedgerSchema.ts')
const {taskMetrics,callEvidence}=await loadTs('../src/reports/taskMetrics.ts')
const scope={source:'real',scopeId:`codex-${'a'.repeat(64)}`},other={source:'real',scopeId:`codex-${'b'.repeat(64)}`}
const now=Date.parse('2026-10-21T12:00:00.000Z'),query={...scope,timeZone:'UTC',startAt:'2026-10-01T00:00:00.000Z',endAt:new Date(now).toISOString()}
function task(id='t1',extra={}){return {...scope,id,label:'整理笔记',category:'summary',startedAt:'2026-10-20T08:00:00.000Z',endedAt:'2026-10-20T08:02:00.000Z',status:'succeeded',origin:'executor',quota:null,calls:[{id:`c-${id}`,taskId:id,provider:'example',model:'model',startedAt:'2026-10-20T08:00:00.000Z',endedAt:'2026-10-20T08:02:00.000Z',status:'succeeded',attempt:1,usage:{inputTokens:100,outputTokens:20,cachedInputTokens:50,basis:'provider-reported'},cost:{amount:.1,currency:'USD',basis:'provider-reported'}}],...extra}}
for(const kind of ['file','browser']){
  async function setup(){
    if(kind==='file'){const file=path.join(await mkdtemp(path.join(tmpdir(),'petcast-task-')),'ledger.json');return {store:new FileTaskLedger(file,()=>now),reopen:()=>new FileTaskLedger(file,()=>now),corrupt:()=>writeFile(file,'broken'),raw:()=>readFile(file,'utf8')}}
    const map=new Map(),storage={getItem:k=>map.get(k)??null,setItem:(k,v)=>{map.set(k,v)}};return {store:new BrowserTaskLedger(storage,()=>now),reopen:()=>new BrowserTaskLedger(storage,()=>now),corrupt:()=>storage.setItem(TASK_LEDGER_KEY,'broken'),raw:()=>storage.getItem(TASK_LEDGER_KEY)}
  }
  test(`${kind}: concurrent writes, idempotent retries, reload and scoped clear`,async()=>{
    const {store,reopen}=await setup();await Promise.all([store.appendTaskRecords([task()]),store.appendTaskRecords([task('t2')]),store.appendTaskRecords([task('t3',other)])]);await store.appendTaskRecords([task()])
    assert.equal((await reopen().queryTaskRecords(query)).length,2)
    await store.clearTaskRecords(scope);assert.equal((await store.queryTaskRecords(query)).length,0);assert.equal((await store.queryTaskRecords({...query,...other})).length,1)
  })
  test(`${kind}: duplicate conflicting task fails atomically; failed batch does not poison queue`,async()=>{
    const {store}=await setup();await store.appendTaskRecords([task()]);await assert.rejects(store.appendTaskRecords([task('t2'),task('t1',{label:'conflict'})]));assert.equal((await store.queryTaskRecords(query)).length,1)
    await store.appendTaskRecords([task('t3')]);assert.equal((await store.queryTaskRecords(query)).length,2)
  })
  test(`${kind}: corruption cannot be turned into empty records or overwritten by clear`,async()=>{
    const s=await setup();await s.corrupt();await assert.rejects(s.store.queryTaskRecords(query));await assert.rejects(s.store.appendTaskRecords([task()]));await assert.rejects(s.store.clearTaskRecords(scope));assert.equal(await s.raw(),'broken')
  })
}
test('schema strips unexpected content and rejects impossible usage, references and times',()=>{
  assert.equal(validateTaskRecord({...task(),prompt:'private'}).prompt,undefined)
  for(const edit of [{taskId:'wrong'},{endedAt:'2026-10-20T09:00:00.000Z'},{usage:{inputTokens:100,outputTokens:1,cachedInputTokens:101,basis:'provider-reported'}},{usage:{inputTokens:-1,outputTokens:1,cachedInputTokens:null,basis:'provider-reported'}},{cost:{amount:1,currency:'usd',basis:'provider-reported'}}])assert.throws(()=>validateTaskRecord({...task(),calls:[{...task().calls[0],...edit}]}))
})
test('a call ID cannot belong to two tasks in the same account',()=>{
  const b=task('t2');b.calls[0].id=task().calls[0].id;assert.throws(()=>appendTasks([task()],[b],now))
})
test('time range uses completion time; missing usage is unknown; cached input is not double counted',()=>{
  const a=task(),b=task('t2');b.calls[0].usage=null
  const r=taskMetrics([a,b,task('failed',{status:'failed'}),task('other',other)],query)
  assert.equal(r.completed,2);assert.equal(r.duration.average,120000);assert.equal(r.tokens.count,1);assert.equal(r.tokens.average,120);assert.equal(r.reportedTokens,240)
  assert.equal(taskMetrics([a],{...query,endAt:a.endedAt}).completed,0)
})
test('costs split by currency and provenance; quota splits by provider/window',()=>{
  const a=task(),b=task('t2'),c=task('t3');b.calls[0].cost.currency='CNY';c.calls[0].cost.basis='price-estimate'
  a.quota={provider:'p',window:'5h',points:5,basis:'exclusive-observation'};b.quota={provider:'p',window:'week',points:2,basis:'exclusive-observation'}
  const r=taskMetrics([a,b,c],query);assert.equal(r.costs.length,3);assert.equal(r.quotas.length,2);assert.equal(r.quotas[0].stats.average,5)
})
test('evidence retains failed attempts; missing desktop interface fails explicitly',async()=>{
  const t=task();t.calls[0].status='failed';t.calls[0].attempt=2
  assert.ok(callEvidence(t).some(s=>s.includes('1 次失败、1 次重试')))
  const store=new DesktopTaskLedger({});await assert.rejects(store.queryTaskRecords(query));await assert.rejects(store.appendTaskRecords([t]));await assert.rejects(store.clearTaskRecords(scope))
})
