import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadTs } from './load-ts.mjs'
const { calculateUsageMetrics } = await loadTs('../src/history/usageMetrics.ts')
const { monthlyReport, createMonthlyDemo } = await loadTs('../src/reports/monthlyReport.ts')
const { habitAdvice } = await loadTs('../src/reports/habitAdvisor.ts')
const start = Date.parse('2026-10-20T00:00:00.000Z')
const scope = {source:'real',scopeId:`codex-${'a'.repeat(64)}`}
const query = {...scope,timeZone:'UTC',startAt:new Date(start).toISOString(),endAt:new Date(start+3600000).toISOString()}
const sample = (minute,quota=80,extra={})=>({...scope,id:`s-${minute}`,sampledAt:new Date(start+minute*60000).toISOString(),shortWindowRemaining:quota,weeklyRemaining:60,shortWindowResetAt:new Date(start+5*3600000).toISOString(),weeklyResetAt:new Date(start+7*86400000).toISOString(),burnRate:999,...extra})
test('rates are recomputed and time weighted, never averaged from supplied burnRate',()=>{
  const r=calculateUsageMetrics([sample(4,75),sample(0),sample(1,78)],query)
  assert.equal(r.coverageMs,240000);assert.equal(r.averageBurnRate,75);assert.equal(r.peakBurnRate,120)
  assert.equal(r.consumedPoints,5);assert.equal(r.hourlyUsage[0],5)
})
test('first, constant-zero and missing records distinguish unknown from zero consumption',()=>{
  for(const samples of [[],[sample(0)]]) {const r=calculateUsageMetrics(samples,query);assert.equal(r.averageBurnRate,null);assert.equal(r.peakBurnRate,null)}
  const r=calculateUsageMetrics([sample(0),sample(3)],query)
  assert.equal(r.averageBurnRate,0);assert.equal(r.peakBurnRate,0);assert.deepEqual(r.activePeriods,[])
  assert.ok(habitAdvice(r)[0].includes('不足'))
})
test('quota recovery, reset and gaps break intervals and do not fabricate pressure entries',()=>{
  for(const [a,b] of [[sample(0,24),sample(1,30)],[sample(0,30),sample(1,24,{shortWindowResetAt:new Date(start+6*3600000).toISOString()})],[sample(0,30),sample(6,24)],[sample(0,30),sample(1,24,{weeklyRemaining:70})]]) {
    const r=calculateUsageMetrics([a,b],query);assert.equal(r.coverageMs,0);assert.equal(r.shortQuotaPressureCount,0);assert.ok(r.warnings.some(x=>x.includes('断档')))
  }
})
test('pressure counts transitions only; initial low samples never count an entry',()=>{
  const r=calculateUsageMetrics([sample(0,26,{weeklyRemaining:23}),sample(1,25,{weeklyRemaining:22}),sample(2,24,{weeklyRemaining:21})],query)
  assert.equal(r.shortQuotaPressureCount,1);assert.equal(r.weeklyQuotaPressureCount,1)
  assert.equal(calculateUsageMetrics([sample(0,24),sample(1,23)],query).shortQuotaPressureCount,0)
})
test('scope isolation, duplicate sampling and [start,end) bounds are enforced',()=>{
  const r=calculateUsageMetrics([sample(0),sample(0),sample(1,78),sample(60,0),sample(-1),sample(1,0,{source:'mock',scopeId:'mock-local'})],query)
  assert.equal(r.sampleCount,2);assert.equal(r.consumedPoints,2)
})
test('consumption splits across local hours and days; unobserved days remain gaps',()=>{
  const at=Date.parse('2026-10-20T15:59:00.000Z')
  const samples=[sample(0,80,{sampledAt:new Date(at).toISOString()}),sample(2,78,{sampledAt:new Date(at+120000).toISOString()})]
  const r=calculateUsageMetrics(samples,{...query,timeZone:'Asia/Shanghai',startAt:new Date(at-60000).toISOString(),endAt:new Date(at+86400000).toISOString()})
  assert.equal(r.hourlyUsage[23],1);assert.equal(r.hourlyUsage[0],1)
  assert.equal(r.dailyUsage[0].consumedPoints,1);assert.equal(r.dailyUsage[1].consumedPoints,1)
  assert.equal(r.coverageMs,120000)
})
test('DST spring-forward attributes consumption to actual local hours',()=>{
  const at=Date.parse('2026-03-08T06:59:00.000Z')
  const r=calculateUsageMetrics([sample(0,80,{sampledAt:new Date(at).toISOString()}),sample(2,78,{sampledAt:new Date(at+120000).toISOString()})],{...query,timeZone:'America/New_York',startAt:new Date(at).toISOString(),endAt:new Date(at+180000).toISOString()})
  assert.equal(r.hourlyUsage[1],1);assert.equal(r.hourlyUsage[2],0);assert.equal(r.hourlyUsage[3],1)
})
test('demo month is explicitly mock and cannot populate a real report',()=>{
  const now=new Date(start),samples=createMonthlyDemo(now)
  const q={...query,startAt:new Date(start-30*86400000).toISOString(),endAt:now.toISOString()}
  assert.equal(monthlyReport(samples,q).sampleCount,0)
  const report=monthlyReport(samples,{...q,source:'mock',scopeId:'mock-demo'})
  assert.equal(report.sampleCount,930);assert.equal(report.coverageMs,30*90*60000)
  assert.ok(report.warnings.some(w=>w.includes('模拟')))
})
