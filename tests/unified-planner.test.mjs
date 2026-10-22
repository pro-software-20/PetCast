import {test} from 'node:test'
import assert from 'node:assert/strict'
import {loadTs} from './load-ts.mjs'
const {recommendTaskPlan}=await loadTs('../src/reports/unifiedPlanner.ts')
const now=Date.parse('2026-10-21T08:00:00.000Z'),scope={source:'mock',scopeId:'mock-local'}
const evaluation={comparisonKey:'size-medium-v1',method:'rubric',rubricVersion:'quality-v1',accepted:true}
const task={...scope,category:'summary',...evaluation,deadlineAt:new Date(now+8*3600000).toISOString(),priority:'normal',allowWait:true,budget:null}
function records(model='cheap',cost=.1,minutes=30,provider='test'){
  return [1,2,3].map(i=>{const id=`${provider}-${model}-${i}`,startedAt=new Date(now-i*86400000).toISOString(),endedAt=new Date(Date.parse(startedAt)+minutes*60000).toISOString();return {...scope,id,label:id,category:'summary',startedAt,endedAt,status:'succeeded',origin:'executor',evaluation,quota:null,calls:[{id:`call-${id}`,taskId:id,provider,model,startedAt,endedAt,status:'succeeded',attempt:1,usage:{inputTokens:1000,outputTokens:200,cachedInputTokens:100,basis:'provider-reported'},cost:{amount:cost,currency:'USD',basis:'provider-reported'}}]}})
}
const capacity=(model='cheap',extra={})=>({...scope,provider:'test',model,enabled:true,preference:10,checkedAt:new Date(now).toISOString(),basis:'user-confirmed',capacity:{kind:'money',currency:'USD',remaining:10},...extra})
const both=()=>[...records(),...records('fast',.5,5)]
const availability=()=>[capacity(),capacity('fast')]

test('opt-in recent quality recovers from old failures while retaining visible evidence',()=>{
  const rows=Array.from({length:6},(_,i)=>{const r=structuredClone(records()[0]),id=`recent-${i}`;r.id=id;r.startedAt=new Date(now-(i+1)*86400000).toISOString();r.endedAt=new Date(Date.parse(r.startedAt)+600000).toISOString();r.calls[0]={...r.calls[0],id:`call-${id}`,taskId:id,startedAt:r.startedAt,endedAt:r.endedAt};return r})
  rows[5].evaluation.accepted=false
  assert.equal(recommendTaskPlan(task,rows,[capacity()],now).state,'unavailable')
  const plan=recommendTaskPlan({...task,qualityPolicy:'recent'},rows,[capacity()],now)
  assert.equal(plan.state,'ready');assert.equal(plan.recommendation.sampleCount,6);assert.equal(plan.recommendation.taskIds.length,6)
  assert.match(plan.recommendation.limitations.join(' '),/失败记录仍保留/)
  rows[0].evaluation.accepted=false
  assert.equal(recommendTaskPlan({...task,qualityPolicy:'recent'},rows,[capacity()],now).state,'unavailable')
  assert.equal(recommendTaskPlan({...task,qualityPolicy:'recent'},rows.slice(1,5),[capacity()],now).state,'unavailable')
})
test('one pending task jointly changes model and time based on priority',()=>{
  const normal=recommendTaskPlan(task,both(),availability(),now)
  assert.equal(normal.state,'ready');assert.equal(normal.recommendation.model,'cheap')
  assert.equal(normal.recommendation.finishAt,new Date(now+40*60000).toISOString())
  const urgent=recommendTaskPlan({...task,priority:'urgent'},both(),availability(),now)
  assert.equal(urgent.recommendation.model,'fast');assert.equal(urgent.recommendation.finishAt,new Date(now+15*60000).toISOString())
  assert.ok(normal.recommendation.taskIds.length===3)
})
test('tight deadline rejects cheap slower model and retains fast feasible one',()=>{
  const r=recommendTaskPlan({...task,deadlineAt:new Date(now+20*60000).toISOString()},both(),availability(),now)
  assert.equal(r.recommendation.model,'fast');assert.equal(r.alternatives[0].state,'blocked');assert.match(r.alternatives[0].reasons.join(' '),/截止/)
})
test('quality failure blocks otherwise cheap fast model; unknown evaluation never counts as pass',()=>{
  const rows=both();rows[0].evaluation={...evaluation,accepted:false}
  assert.equal(recommendTaskPlan(task,rows,availability(),now).recommendation.model,'fast')
  delete rows[0].evaluation
  assert.equal(recommendTaskPlan(task,rows,availability(),now).recommendation.model,'fast')
  const r=recommendTaskPlan(task,records().slice(0,2),[capacity()],now);assert.equal(r.state,'unavailable');assert.match(r.alternatives[0].reasons[0],/至少需要 3/)
})
test('cost upper bound and actual available budget both constrain selection',()=>{
  assert.equal(recommendTaskPlan({...task,budget:{currency:'USD',amount:.05}},both(),availability(),now).state,'unavailable')
  const a=availability();a[0].capacity.remaining=.01
  assert.equal(recommendTaskPlan(task,both(),a,now).recommendation.model,'fast')
})
test('estimated charges never count as real-price evidence for a monetary budget',()=>{
  const rows=records();for(const r of rows)r.calls[0].cost.basis='price-estimate'
  const r=recommendTaskPlan(task,rows,[capacity()],now);assert.equal(r.state,'unavailable');assert.match(r.alternatives[0].reasons.join(' '),/实际费用/)
})
const windows=(short=80,weekly=50)=>({kind:'quota',windows:[{key:'short',remaining:short,needed:30,resetAt:new Date(now+3600000).toISOString()},{key:'weekly',remaining:weekly,needed:10,resetAt:new Date(now+4*3600000).toISOString()}]})
test('quota-constrained cheap model can yield conditional combined plan, not a guaranteed schedule',()=>{
  const a=[capacity('cheap',{provider:'codex',capacity:windows(0)}),capacity('fast')],rows=[...records('cheap',.1,30,'codex'),...records('fast',.5,5)]
  const r=recommendTaskPlan(task,rows,a,now);assert.equal(r.state,'recheck');assert.equal(r.recommendation.provider,'codex');assert.equal(r.recommendation.startAt,new Date(now+3600000).toISOString());assert.match(r.recommendation.limitations.join(' '),/不保证/)
  assert.equal(recommendTaskPlan({...task,priority:'urgent'},rows,a,now).recommendation.model,'fast')
  assert.equal(recommendTaskPlan({...task,allowWait:false},rows,a,now).recommendation.model,'fast')
})
test('both quota windows and deadline buffer are mandatory',()=>{
  const rows=records('cheap',.1,30,'codex'),a=capacity('cheap',{provider:'codex',capacity:windows(0,0)})
  const r=recommendTaskPlan(task,rows,[a],now);assert.equal(r.recommendation.startAt,new Date(now+4*3600000).toISOString())
  assert.equal(recommendTaskPlan({...task,deadlineAt:new Date(now+4.5*3600000).toISOString()},rows,[a],now).state,'unavailable')
  a.capacity.windows.pop();assert.equal(recommendTaskPlan(task,rows,[a],now).state,'unavailable')
})
test('wrong account, stale, future and disabled availability cannot authorize plans',()=>{
  for(const edit of [{scopeId:'mock-other'},{checkedAt:new Date(now-300001).toISOString()},{checkedAt:new Date(now+1).toISOString()},{enabled:false}])assert.equal(recommendTaskPlan(task,records(),[capacity('cheap',edit)],now).state,'unavailable')
})
test('future/expired/foreign history and duplicate records do not pad evidence',()=>{
  const row=records()[0]
  assert.equal(recommendTaskPlan(task,[row,row,row],[capacity()],now).state,'unavailable')
  for(const edit of [{scopeId:'mock-other'},{endedAt:new Date(now+1).toISOString()},{startedAt:new Date(now-100*86400000).toISOString(),endedAt:new Date(now-99*86400000).toISOString(),calls:[]}]){
    const rows=records().map(r=>({...r,...edit}));assert.notEqual(recommendTaskPlan(task,rows,[capacity()],now).state,'ready')
  }
})
test('mixed currencies are not compared as cheap/expensive; finish time ranks instead',()=>{
  const rows=both();for(const t of rows.slice(3))t.calls[0].cost.currency='CNY'
  const a=availability();a[1].capacity.currency='CNY'
  const r=recommendTaskPlan(task,rows,a,now);assert.equal(r.recommendation.model,'fast');assert.match(r.explanation,/无法判定哪个更省/)
})
test('unknown consumption cannot produce a plan; quota-only history may support nonfinancial timing',()=>{
  const rows=records('cheap',.1,30,'codex');for(const t of rows){t.calls[0].cost=null;t.calls[0].usage=null}
  const a=capacity('cheap',{provider:'codex',capacity:windows()})
  assert.equal(recommendTaskPlan(task,rows,[a],now).state,'unavailable')
  for(const t of rows)t.quota={provider:'codex',window:'short',points:20,basis:'exclusive-observation'}
  assert.equal(recommendTaskPlan(task,rows,[a],now).state,'ready')
  assert.equal(recommendTaskPlan({...task,budget:{currency:'USD',amount:1}},rows,[a],now).state,'unavailable')
})
test('invalid inputs and duplicate availability fail clearly',()=>{
  assert.equal(recommendTaskPlan({...task,deadlineAt:'bad'},records(),[capacity()],now).state,'invalid')
  assert.equal(recommendTaskPlan({...task,deadlineAt:new Date(now).toISOString()},records(),[capacity()],now).state,'invalid')
  assert.equal(recommendTaskPlan(task,records(),[capacity(),capacity()],now).state,'invalid')
  const rows=records();rows[1].calls[0].id=rows[0].calls[0].id;assert.equal(recommendTaskPlan(task,rows,[capacity()],now).state,'invalid')
})
test('model preference breaks ties after feasibility and priority criteria',()=>{
  const rows=[...records(),...records('tie',.1,30)],a=[capacity('cheap',{preference:20}),capacity('tie',{preference:1})]
  assert.equal(recommendTaskPlan(task,rows,a,now).recommendation.model,'tie')
})


test('malformed resource collections and window entries fail closed instead of throwing',()=>{
  for(const invalid of [null,{},42])assert.equal(recommendTaskPlan(task,records(),invalid,now).state,'invalid')
  for(const windows of [[null],[undefined],[{}]]){
    const r=recommendTaskPlan(task,records(),[capacity('cheap',{capacity:{kind:'quota',windows}})],now)
    assert.equal(r.state,'unavailable')
  }
})


const price={currency:'USD',version:'test-v1',sourceUrl:'https://example.com/pricing',validFrom:new Date(now-86400000).toISOString(),validUntil:new Date(now+86400000).toISOString(),inputPerMillion:2,cachedInputPerMillion:1,outputPerMillion:4,standardTokenBilling:true}
test('capabilities filter incompatible cheap models and explicit locking never bypasses constraints',()=>{
  const requirements={images:true,tools:true,contextTokens:8000}
  const a=[capacity('cheap',{capabilities:{images:false,tools:true,contextTokens:100000}}),capacity('fast',{capabilities:{images:true,tools:true,contextTokens:8192}})]
  assert.equal(recommendTaskPlan({...task,requirements},both(),a,now).recommendation.model,'fast')
  assert.equal(recommendTaskPlan({...task,requirements,lockedModel:{provider:'test',model:'cheap'}},both(),a,now).state,'unavailable')
  a[1].capabilities.contextTokens=4000;assert.equal(recommendTaskPlan({...task,requirements},both(),a,now).state,'unavailable')
})
test('current-price estimates require explicit opt-in and show provenance, with cache counted once',()=>{
  const rows=records();for(const t of rows)t.calls[0].cost=null
  const a=[capacity('cheap',{price})]
  assert.equal(recommendTaskPlan(task,rows,a,now).state,'unavailable')
  const r=recommendTaskPlan({...task,allowEstimatedCost:true},rows,a,now)
  assert.equal(r.state,'ready');assert.equal(r.recommendation.cost.basis,'current-price-estimate');assert.equal(r.recommendation.cost.amount,.0027);assert.equal(r.recommendation.cost.priceVersion,'test-v1')
  assert.equal(rows[0].calls[0].cost,null)
})
test('expired prices, unconfirmed billing and unknown cache split cannot invent comparable costs',()=>{
  const rows=records();for(const t of rows)t.calls[0].cost=null
  for(const edit of [{validUntil:new Date(now).toISOString()},{validFrom:new Date(now+1).toISOString()},{standardTokenBilling:false},{sourceUrl:'javascript:bad'},{inputPerMillion:-1}])assert.equal(recommendTaskPlan({...task,allowEstimatedCost:true},rows,[capacity('cheap',{price:{...price,...edit}})],now).state,'unavailable')
  rows[0].calls[0].usage.cachedInputTokens=null
  assert.equal(recommendTaskPlan({...task,allowEstimatedCost:true},rows,[capacity('cheap',{price})],now).state,'unavailable')
  assert.equal(recommendTaskPlan({...task,allowEstimatedCost:true},rows,[capacity('cheap',{price:{...price,cachedInputPerMillion:2}})],now).state,'ready')
})
test('explicit current prices can change future recommendation without rewriting historical real costs',()=>{
  const rows=both(),before=structuredClone(rows),a=[capacity('cheap',{price:{...price,inputPerMillion:1000,outputPerMillion:1000,cachedInputPerMillion:1000}}),capacity('fast')]
  assert.equal(recommendTaskPlan({...task,allowEstimatedCost:true},rows,a,now).recommendation.model,'fast')
  assert.deepEqual(rows,before)
})


test('estimated price must remain effective through the proposed execution window',()=>{
  const a=capacity('cheap',{provider:'codex',capacity:windows(0),price:{...price,validUntil:new Date(now+3600000).toISOString()}})
  const r=recommendTaskPlan({...task,allowEstimatedCost:true},records('cheap',.1,30,'codex'),[a],now)
  assert.equal(r.state,'unavailable');assert.match(r.alternatives[0].reasons.join(' '),/价格有效期/)
})
