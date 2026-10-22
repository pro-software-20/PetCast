import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadTs } from './load-ts.mjs'
const {calendarRange,calendarQuery,previousQuery,dayStart,DEFAULT_SETTINGS}=await loadTs('../src/reports/reportCalendar.ts')
const {calculateUsageMetrics}=await loadTs('../src/history/usageMetrics.ts')
const {habitAdvice}=await loadTs('../src/reports/habitAdvisor.ts')
const {achievements,compareReports}=await loadTs('../src/reports/reportInsights.ts')
const scope={source:'mock',scopeId:'mock-local'},now=Date.parse('2026-10-21T12:00:00.000Z')
test('weekly bounds support default week, cross-week and same-day settings',()=>{
  assert.deepEqual(calendarRange('week',DEFAULT_SETTINGS,'UTC','2026-10-21'),{start:'2026-10-19',end:'2026-10-25'})
  assert.deepEqual(calendarRange('week',{weekStart:5,weekEnd:4},'UTC','2026-10-21'),{start:'2026-10-16',end:'2026-10-22'})
  assert.deepEqual(calendarRange('week',{weekStart:1,weekEnd:1},'UTC','2026-10-21'),{start:'2026-10-19',end:'2026-10-19'})
})
test('calendar months handle leap years and year boundaries',()=>{
  assert.deepEqual(calendarRange('month',DEFAULT_SETTINGS,'UTC','2024-02-19'),{start:'2024-02-01',end:'2024-02-29'})
  assert.deepEqual(calendarRange('month',DEFAULT_SETTINGS,'UTC','2026-12-01'),{start:'2026-12-01',end:'2026-12-31'})
  assert.throws(()=>calendarRange('week',{weekStart:8,weekEnd:1},'UTC','2026-10-21'))
})
test('inclusive end date, now clipping and invalid date validation',()=>{
  const q=calendarQuery(scope,'Asia/Shanghai','2026-10-01','2026-10-31',now)
  assert.equal(q.startAt,'2026-09-30T16:00:00.000Z');assert.equal(q.endAt,new Date(now).toISOString())
  assert.equal(calendarQuery(scope,'UTC','2026-10-01','2026-10-02',now).endAt,'2026-10-03T00:00:00.000Z')
  for(const [a,b] of [['2026-10-03','2026-10-01'],['2026-11-01','2026-11-30'],['2026-02-30','2026-03-01'],['2026-01-01','2026-10-01']])assert.throws(()=>calendarQuery(scope,'UTC',a,b,now))
})
test('DST civil-day boundaries are 23/25 hours; skipped civil date is rejected',()=>{
  assert.equal(dayStart('2026-03-09','America/New_York')-dayStart('2026-03-08','America/New_York'),23*3600000)
  assert.equal(dayStart('2026-11-02','America/New_York')-dayStart('2026-11-01','America/New_York'),25*3600000)
  assert.throws(()=>dayStart('2011-12-30','Pacific/Apia'))
})
test('prior period uses elapsed time and calendar month, including shorter February',()=>{
  const q=calendarQuery(scope,'UTC','2026-10-01','2026-10-31',now),p=previousQuery(q,'month')
  assert.equal(p.startAt,'2026-09-01T00:00:00.000Z');assert.equal(p.endAt,'2026-09-21T12:00:00.000Z')
  const march={...q,startAt:'2026-03-01T00:00:00.000Z',endAt:'2026-04-01T00:00:00.000Z'}
  assert.equal(previousQuery(march,'month').endAt,march.startAt)
})
function fixture(days=3,hour=8){
  const samples=[]
  for(let day=0;day<days;day++)for(let i=0;i<=40;i++)samples.push({...scope,id:`s-${day}-${i}`,sampledAt:new Date(Date.UTC(2026,9,1+day,hour,i*3)).toISOString(),shortWindowRemaining:90-i,weeklyRemaining:90,shortWindowResetAt:new Date(Date.UTC(2026,9,1+day,20)).toISOString(),weeklyResetAt:'2026-10-30T00:00:00.000Z',burnRate:null})
  return calculateUsageMetrics(samples,{...scope,timeZone:'UTC',startAt:'2026-10-01T00:00:00.000Z',endAt:'2026-10-20T00:00:00.000Z'})
}
test('habit evidence requires distinct days and duration, titles never reward one long day',()=>{
  const weak=fixture(1);assert.equal(weak.habitReady,false);assert.deepEqual(achievements(weak),[])
  const strong=fixture();assert.equal(strong.habitReady,true);assert.ok(habitAdvice(strong).some(s=>s.includes('观测规律')))
  assert.ok(achievements(strong).some(a=>a.name==='晨光搭档'))
  assert.equal(fixture(3,0).paceLabel,'可描述观测规律');assert.ok(!achievements(fixture(3,0)).some(a=>a.name.includes('夜')))
})
test('existing low quota contributes duration even without a pressure-entry event',()=>{
  const q={...scope,timeZone:'UTC',startAt:'2026-10-01T00:00:00.000Z',endAt:'2026-10-02T00:00:00.000Z'}
  const samples=[0,3].map((m)=>({...scope,id:`low-${m}`,sampledAt:`2026-10-01T00:0${m}:00.000Z`,shortWindowRemaining:20-m,weeklyRemaining:20,shortWindowResetAt:'2026-10-01T05:00:00.000Z',weeklyResetAt:'2026-10-07T00:00:00.000Z',burnRate:null}))
  const r=calculateUsageMetrics(samples,q);assert.equal(r.shortQuotaPressureCount,0);assert.equal(r.shortPressureMs,180000);assert.equal(r.weeklyPressureMs,180000)
  assert.ok(habitAdvice(r).some(s=>s.includes('持续 3 分钟')))
})
test('comparisons reject uneven sampling and do not divide by zero',()=>{
  assert.match(compareReports(fixture(),fixture(1)),/暂不可用/)
  assert.match(compareReports(fixture(),fixture(3,20)),/时段分布/)
  assert.match(compareReports(fixture(),{...fixture(),averageBurnRate:0}),/零基数/)
  assert.match(compareReports(fixture(),fixture()),/0.0%/)
})
