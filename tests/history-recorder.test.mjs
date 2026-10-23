import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadTs } from './load-ts.mjs'
const { UsageHistoryRecorder } = await loadTs('../src/history/UsageHistoryRecorder.ts')
const { calculateUsageMetrics } = await loadTs('../src/history/usageMetrics.ts')
const at=Date.parse('2026-10-20T00:00:00.000Z'),scopeId=`codex-${'a'.repeat(64)}`
const reading=(seconds,remaining=80,extra={})=>({status:'fresh',source:'real',checkedAt:new Date(at+seconds*1000),error:null,data:{scopeId,sampledAt:new Date(at+seconds*1000),shortWindowRemaining:remaining,weeklyRemaining:70,shortWindowResetAt:new Date(at+5*3600000),weeklyResetAt:new Date(at+7*86400000),burnRate:null,baselineBurnRate:null,recentResetType:null,...extra}})
function setup(){const rows=[]; const store={appendUsageSample:async s=>{rows.push(s)},clearUsageHistory:async()=>{rows.length=0}};return {rows,store,recorder:new UsageHistoryRecorder(store)}}
test('recorder excludes stale/unavailable and samples fresh every three minutes',async()=>{
  const {rows,recorder}=setup()
  await recorder.record(reading(0));await recorder.record(reading(30,79));await recorder.record({...reading(90),status:'stale'});await recorder.record(null);await recorder.record(reading(180,77))
  assert.equal(rows.length,2);assert.equal(rows[1].shortWindowRemaining,77)
})
test('recording errors retry, duplicate effects are idempotent, scopes are isolated',async()=>{
  const {rows,recorder,store}=setup();let fail=true
  store.appendUsageSample=async s=>{if(fail)throw Error('full');rows.push(s)}
  await assert.rejects(recorder.record(reading(0)));fail=false
  await Promise.all([recorder.record(reading(0)),recorder.record(reading(0))])
  await recorder.record(reading(30,60,{scopeId:`codex-${'b'.repeat(64)}`}))
  assert.equal(rows.length,2)
})
test('pressure boundary records immediately and scoped clear permits a new first sample',async()=>{
  const {rows,recorder}=setup();await recorder.record(reading(0,26));await recorder.record(reading(30,25));assert.equal(rows.length,2)
  await recorder.clear({source:'real',scopeId});await recorder.record(reading(60,24));assert.equal(rows.length,1)
})
test('a recovery hidden within the normal recording interval must break statistics',async()=>{
  const {rows,recorder}=setup()
  await recorder.record(reading(0,80));await recorder.record(reading(30,79));await recorder.record(reading(60,79.5));await recorder.record(reading(240,77))
  assert.ok(rows.some(s=>s.shortWindowRemaining===79), 'save observation preceding recovery')
  assert.ok(rows.some(s=>s.shortWindowRemaining===79.5), 'save recovery boundary')
  const report=calculateUsageMetrics(rows,{source:'real',scopeId,timeZone:'UTC',startAt:new Date(at).toISOString(),endAt:new Date(at+300000).toISOString()})
  assert.equal(report.consumedPoints,3.5)
  assert.equal(report.coverageMs,210000)
})
test('failed recovery-boundary write retries without losing the preceding observation',async()=>{
  const {rows,recorder,store}=setup()
  await recorder.record(reading(0,80));await recorder.record(reading(30,79))
  let fail=true;store.appendUsageSample=async s=>{if(fail)throw Error('disk full');rows.push(s)}
  await assert.rejects(recorder.record(reading(60,79.5)));fail=false
  await recorder.record(reading(60,79.5))
  assert.deepEqual(rows.map(s=>s.shortWindowRemaining),[80,79,79.5])
})
