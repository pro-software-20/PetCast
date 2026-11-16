import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTs } from './load-ts.mjs'
const { TaskEvidenceAdapter }=await loadTs('../src/reports/taskEvidenceAdapter.ts')
const { runTaskEvaluationAdapterConformance }=await loadTs('../src/orchestration/evaluationAdapterConformance.ts')
const { createTaskEvaluationRequestFixture }=await loadTs('../src/orchestration/taskEvaluationFixtures.ts')
const { taskTiming,taskHabits }=await loadTs('../src/reports/taskHabits.ts')
const { listResources }=await loadTs('../src/reports/resourceHistory.ts')
test('D evidence client passes B adapter scenarios including cancellation and ID conflicts',async()=>{
  const result=await runTaskEvaluationAdapterConformance({providerId:'deepseek',createRequest:createTaskEvaluationRequestFixture,
    createAdapter:scenario=>{
      const adapter=new TaskEvidenceAdapter(async req=>{
      return req.task.acceptanceChecks.map(label=>({label,status:scenario==='revise'?'failed':scenario==='unknown'?'not-run':'passed'}))
      })
      // Inject a corrupt response after the adapter to exercise the B-side boundary.
      return scenario==='invalid-response'?{evaluate:async(...args)=>({...await adapter.evaluate(...args),extra:true})}:adapter
    }})
  assert.equal(result.passed,true,JSON.stringify(result.checks.filter(c=>!c.passed)))
})
test('local rules require evidence per criterion and preserve failure',async()=>{
  for(const [status,evidence,expected] of [['passed',false,'unknown'],['passed',true,'accepted'],['failed',true,'revise']]){
    const req=createTaskEvaluationRequestFixture()
    req.result.verification[0].status=status
    req.result.evidence=evidence?[{type:'user-review',reference:'check:0',summary:'已核对'}]:[]
    const report=await new TaskEvidenceAdapter().evaluate(req,new AbortController().signal)
    assert.equal(report.verdict,expected)
  }
})
test('timing merges overlapping calls and missing retry usage does not add tokens',()=>{
  const at=s=>new Date(s*1000).toISOString()
  const c={provider:'P',model:'M',startedAt:at(2),endedAt:at(7),attempt:1,usage:{inputTokens:3,outputTokens:4}}
  const t={category:'写作',startedAt:at(0),endedAt:at(10),calls:[c,{...c,startedAt:at(4),endedAt:at(8),attempt:2,usage:null}]}
  assert.deepEqual(taskTiming(t),{elapsed:10000,active:6000,gap:4000})
  assert.equal(taskHabits([t]).providers[0].tokens,7)
  assert.equal(taskHabits([t]).measuredRetries,0)
})
test('resource summaries keep accounts, units, and half-open period distinct',()=>{
  const q={source:'mock',scopeId:'a',startAt:'2026-11-01',endAt:'2026-11-08'}
  const s={...q,at:'2026-11-03',provider:'P',account:'first',kind:'balance',unit:'CNY',value:4}
  const rows=listResources(q,[s,{...s,at:'2026-11-05',value:2},{...s,unit:'USD'},{...s,scopeId:'b'},{...s,at:q.endAt}])
  assert.deepEqual(rows.map(r=>[r.unit,r.value]),[['CNY',2],['USD',4]])
})


test('malformed evidence client results are rejected before dispatch',async()=>{
  const adapter=new TaskEvidenceAdapter(async()=>[])
  await assert.rejects(adapter.evaluate(createTaskEvaluationRequestFixture(),new AbortController().signal))
})
