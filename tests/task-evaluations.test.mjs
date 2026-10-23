import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,writeFile} from 'node:fs/promises'
import path from 'node:path'
import {tmpdir} from 'node:os'
import {loadTs} from './load-ts.mjs'
const {FileTaskLedger}=await loadTs('../electron/taskLedgerStore.ts')
const {BrowserTaskLedger,TASK_LEDGER_KEY}=await loadTs('../src/history/TaskLedger.ts')
const {applyTaskEvaluations}=await loadTs('../electron/taskEvaluations.ts')
const {recommendationQuery}=await loadTs('../src/history/recommendationHistory.ts')
const now=Date.parse('2026-10-21T12:00:00.000Z'),scope={source:'mock',scopeId:'mock-local'},other={source:'mock',scopeId:'mock-other'}
const task={...scope,id:'task1',label:'task',category:'test',origin:'executor',status:'succeeded',startedAt:'2026-10-10T01:00:00.000Z',endedAt:'2026-10-10T02:00:00.000Z',calls:[],quota:null}
const event={...scope,id:'review1',taskId:'task1',createdAt:new Date(now).toISOString(),supersedes:null,method:'user',comparisonKey:'medium',rubricVersion:'v1',verdict:'accepted',note:'checked'}
const query=recommendationQuery(scope,90,now+1)
for(const mode of ['file','browser']){
  async function setup(){
    if(mode==='file'){const file=path.join(await mkdtemp(path.join(tmpdir(),'petcast-eval-')),'tasks.json');return {ledger:new FileTaskLedger(file,()=>now),reopen:()=>new FileTaskLedger(file,()=>now),raw:()=>readFile(file,'utf8'),write:v=>writeFile(file,v)}}
    const data=new Map();const storage={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v)}
    return {ledger:new BrowserTaskLedger(storage,()=>now),reopen:()=>new BrowserTaskLedger(storage,()=>now),raw:()=>data.get(TASK_LEDGER_KEY)??null,write:async v=>{data.set(TASK_LEDGER_KEY,v)}}
  }
  test(`${mode}: migrate legacy, persist review and revisions without rewriting execution`,async()=>{
    const s=await setup();await s.write(JSON.stringify({version:1,tasks:[task]}))
    await s.ledger.appendTaskEvaluations([event]);await s.ledger.appendTaskEvaluations([event])
    await s.ledger.appendTaskEvaluations([{...event,id:'review2',supersedes:event.id,verdict:'revise'}])
    const raw=await s.reopen().queryTaskRecords(query),events=await s.reopen().queryTaskEvaluations(query)
    assert.deepEqual(raw,[task]);assert.equal(events.length,2);assert.equal(JSON.parse(await s.raw()).version,2)
    assert.equal(applyTaskEvaluations(raw,events)[0].evaluation.accepted,false)
    await s.ledger.appendTaskEvaluations([{...event,id:'review3',supersedes:'review2',verdict:'unknown'}])
    assert.equal(applyTaskEvaluations(raw,await s.ledger.queryTaskEvaluations(query))[0].evaluation,undefined)
  })
  test(`${mode}: stale concurrent review, wrong account, orphan and invalid times fail atomically`,async()=>{
    const s=await setup();await s.ledger.appendTaskRecords([task]);await s.ledger.appendTaskEvaluations([event])
    const before=await s.raw()
    for(const edit of [{id:'stale'},{...other,id:'foreign'},{id:'orphan',taskId:'missing'},{id:'early',createdAt:'2026-10-09T01:00:00.000Z'},{id:'late',createdAt:new Date(now+300001).toISOString()}])await assert.rejects(s.ledger.appendTaskEvaluations([{...event,id:'valid',supersedes:event.id},{...event,...edit}]))
    assert.equal(await s.raw(),before)
  })
  test(`${mode}: append and clear preserve other scopes, corrupt journal is never erased`,async()=>{
    const s=await setup();await s.ledger.appendTaskRecords([task,{...task,...other}])
    await s.ledger.appendTaskEvaluations([event,{...event,...other}]);await s.ledger.appendTaskRecords([{...task,id:'task2'}])
    assert.equal((await s.ledger.queryTaskEvaluations(query)).length,1)
    await s.ledger.clearTaskRecords(scope)
    assert.equal((await s.ledger.queryTaskEvaluations(query)).length,0)
    assert.equal((await s.ledger.queryTaskEvaluations({...query,...other})).length,1)
    const corrupt=JSON.stringify({version:2,tasks:[task],evaluations:[{...event,supersedes:'missing'}]});await s.write(corrupt)
    await assert.rejects(s.ledger.queryTaskRecords(query));await assert.rejects(s.ledger.clearTaskRecords(scope));await assert.rejects(s.ledger.appendTaskEvaluations([event]));assert.equal(await s.raw(),corrupt)
  })
  test(`${mode}: future reviews do not affect current recommendations`,async()=>{
    const s=await setup();await s.ledger.appendTaskRecords([task]);await s.ledger.appendTaskEvaluations([{...event,createdAt:new Date(now+1000).toISOString()}])
    assert.equal((await s.ledger.queryTaskEvaluations(query)).length,0)
  })
}
test('rolling recommendation range is independent from report start/end and rejects invalid windows',()=>{
  assert.deepEqual(recommendationQuery({...scope,startAt:'2026-10-20',endAt:'2026-10-21'},90,now),recommendationQuery({...scope,startAt:'2026-10-01'},90,now))
  assert.equal(Date.parse(recommendationQuery(scope,30,now).startAt),now-30*86400000)
  assert.throws(()=>recommendationQuery(scope,1,now))
})
