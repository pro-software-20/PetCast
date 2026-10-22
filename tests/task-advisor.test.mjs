import {test} from 'node:test'
import assert from 'node:assert/strict'
import {loadTs} from './load-ts.mjs'
const {taskAdvice,timingAdvice}=await loadTs('../src/reports/taskAdvisor.ts')
const {validateTaskRecord,parseTaskDocument}=await loadTs('../electron/taskLedgerSchema.ts')
const scope={source:'mock',scopeId:'mock-local'},query={...scope,timeZone:'UTC',startAt:'2026-10-01T00:00:00.000Z',endAt:'2026-10-31T00:00:00.000Z'}
const base=Date.parse('2026-10-10T00:00:00.000Z')
const evaluation={comparisonKey:'same-dataset-size-v1',accepted:true,method:'rubric',rubricVersion:'summary-v1'}
function task(n=1,model='model-a',cost=.1){
  const id=`task-${n}`,startedAt=new Date(base+n*3600000).toISOString(),endedAt=new Date(base+n*3600000+600000).toISOString()
  return {...scope,id,label:`任务 ${n}`,category:'summary',origin:'executor',startedAt,endedAt,status:'succeeded',quota:null,evaluation,calls:[{id:`call-${n}`,taskId:id,provider:'test',model,attempt:1,status:'succeeded',startedAt,endedAt,usage:{inputTokens:100,outputTokens:100,cachedInputTokens:null,basis:'provider-reported'},cost:{amount:cost,currency:'USD',basis:'provider-reported'}}]}
}
const kinds=t=>taskAdvice(t,query).map(a=>a.kind)
test('empty and foreign-account data cannot produce personal recommendations',()=>{
  assert.equal(taskAdvice([],query)[0].id,'no-tasks')
  assert.equal(taskAdvice([{...task(),scopeId:'mock-other'}],query)[0].id,'no-tasks')
})
test('failed retry counted once, unknown tokens not inferred',()=>{
  const t=task();t.calls[0].status='failed';t.calls[0].attempt=2;t.calls[0].usage=null
  const advice=taskAdvice([t],query),r=advice.find(a=>a.kind==='retry')
  assert.match(r.evidence,/1 次属于失败或重试/);assert.match(r.evidence,/0 次提供用量/)
  assert.ok(advice.some(a=>a.id==='missing-usage'));assert.ok(!advice.some(a=>a.kind==='context'))
})
test('context/output suggestions require complete measured usage and meaningful volume',()=>{
  const t=task();t.calls[0].usage.inputTokens=4000
  assert.ok(kinds([t]).includes('context'))
  t.calls.push({...t.calls[0],id:'missing-call',usage:null});assert.ok(!kinds([t]).includes('context'))
  const out=task();out.calls[0].usage.outputTokens=3000;assert.ok(kinds([out]).includes('output'))
  assert.ok(!kinds([task()]).includes('context'))
})
test('same-model baseline only uses preceding completed tasks, excludes future and insufficient history',()=>{
  const t=task(4);t.calls[0].usage.inputTokens=900
  assert.ok(kinds([task(1),task(2),task(3),t]).includes('outlier'))
  assert.ok(!kinds([task(1),task(2),t]).includes('outlier'))
  assert.ok(!kinds([task(5),task(6),task(7),t]).includes('outlier'))
  assert.ok(!kinds([task(1,'other'),task(2,'other'),task(3,'other'),t]).includes('outlier'))
})
const comparison=()=>[task(1),task(2),task(3),task(4,'model-b',.05),task(5,'model-b',.05),task(6,'model-b',.05)]
test('model advice requires same evaluated cohort, real comparable costs, sample count and acceptable latency',()=>{
  const advice=taskAdvice(comparison(),query).find(a=>a.kind==='model')
  assert.ok(advice);assert.match(advice.title,/model-b/);assert.equal(advice.taskIds.length,6)
  for(const change of [t=>{t.evaluation={...evaluation,accepted:false}},t=>{t.calls[0].cost.basis='price-estimate'},t=>{t.calls[0].cost=null},t=>{t.evaluation={...evaluation,rubricVersion:'different'}},t=>{t.evaluation=undefined},t=>{t.status='failed'},t=>{t.calls[0].cost.currency='CNY'}]){
    const tasks=comparison();change(tasks[5]);assert.ok(!kinds(tasks).includes('model'))
  }
  const slow=comparison();for(const t of slow.slice(3))t.endedAt=new Date(Date.parse(t.startedAt)+3600000).toISOString();assert.ok(!kinds(slow).includes('model'))
  assert.ok(!kinds(comparison().slice(1)).includes('model'))
})
test('deduplication avoids inflating model evidence; missing evaluation remains compatible',()=>{
  const a=task(1),b=task(2,'model-b',.01)
  assert.ok(!kinds([a,a,a,b,b,b]).includes('model'))
  const old=task();delete old.evaluation
  assert.equal(parseTaskDocument(JSON.stringify({version:1,tasks:[old]}))[0].evaluation,undefined)
  assert.equal(validateTaskRecord(task()).evaluation.accepted,true)
  assert.throws(()=>validateTaskRecord({...task(),evaluation:{...evaluation,accepted:'yes'}}))
})
test('imported evidence is disclosed',()=>{
  assert.ok(taskAdvice([{...task(),origin:'import'}],query).some(a=>a.id==='imported-evidence'))
})
const now=Date.parse('2026-10-21T12:00:00.000Z')
const pending={...scope,deadlineAt:new Date(now+8*3600000).toISOString(),urgent:false,estimatedDurationMs:3600000,shortPoints:40,weeklyPoints:10}
const quota={...scope,fresh:true,sampledAt:new Date(now).toISOString(),shortRemaining:20,weeklyRemaining:50,shortResetAt:new Date(now+3600000).toISOString(),weeklyResetAt:new Date(now+4*3600000).toISOString()}
test('scheduling suggests a recheck only, and accounts for both windows',()=>{
  const a=timingAdvice(pending,quota,now);assert.match(a.title,/等待恢复后再检查/);assert.match(a.action,/重新读取/)
  const both=timingAdvice({...pending,weeklyPoints:60},quota,now);assert.match(both.evidence,/16:00:00/)
  assert.match(timingAdvice({...pending,weeklyPoints:60,deadlineAt:new Date(now+5*3600000).toISOString()},quota,now).title,/赶不上/)
})
test('stale, future, wrong-account and missing quota never justify a wait',()=>{
  for(const q of [null,{...quota,fresh:false},{...quota,scopeId:'mock-other'},{...quota,sampledAt:new Date(now-300001).toISOString()},{...quota,sampledAt:new Date(now+1).toISOString()},{...quota,shortRemaining:NaN}])assert.match(timingAdvice(pending,q,now).title,/刷新/)
})
test('urgent and too-tight tasks do not get delayed; invalid estimates and elapsed resets rejected',()=>{
  assert.match(timingAdvice({...pending,urgent:true},quota,now).title,/紧急/)
  assert.match(timingAdvice({...pending,deadlineAt:new Date(now+3600000).toISOString()},quota,now).title,/截止时间较紧/)
  assert.match(timingAdvice({...pending,shortPoints:NaN},quota,now).title,/补全/)
  assert.match(timingAdvice({...pending,deadlineAt:'bad'},quota,now).title,/补全/)
  assert.match(timingAdvice(pending,{...quota,shortResetAt:new Date(now-1).toISOString()},now).title,/重新确认/)
  assert.match(timingAdvice({...pending,shortPoints:10},quota,now).title,/覆盖填写的预算/)
})


test('exact deadline including buffer agrees with the unified planner, invalid clock rejected',()=>{
  const t={...pending,shortPoints:10,deadlineAt:new Date(now+pending.estimatedDurationMs+Math.max(600000,pending.estimatedDurationMs*.2)).toISOString()}
  assert.match(timingAdvice(t,quota,now).title,/覆盖填写的预算/)
  assert.match(timingAdvice(pending,quota,NaN).title,/补全/)
})
