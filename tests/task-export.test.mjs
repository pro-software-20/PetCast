import {test} from 'node:test'
import assert from 'node:assert/strict'
import {loadTs} from './load-ts.mjs'
const {filterTasks,taskCsv}=await loadTs('../src/reports/taskExport.ts')
const {validateTaskRecord}=await loadTs('../electron/taskLedgerSchema.ts')
const t={source:'mock',scopeId:'mock-local',id:'t1',label:'=malicious',category:'test',status:'succeeded',origin:'executor',quota:null,startedAt:'2026-10-20T01:00:00.000Z',endedAt:'2026-10-20T02:00:00.000Z',calls:[{id:'c1',taskId:'t1',provider:'p',model:'m',status:'succeeded',attempt:1,startedAt:'2026-10-20T01:00:00.000Z',endedAt:'2026-10-20T02:00:00.000Z',usage:null,cost:null}]}
test('filtered export retains unknowns and neutralizes spreadsheet formula text',()=>{
  const csv=taskCsv([t],[]);assert.ok(csv.startsWith('\ufeff'));assert.ok(csv.includes("'=malicious"));assert.ok(csv.includes('"unknown"'));assert.ok(!csv.includes('undefined'))
  const filters={search:'t1',category:'test',status:'succeeded',model:JSON.stringify(['p','m'])}
  assert.equal(filterTasks([t],filters).length,1);assert.equal(filterTasks([t],{...filters,status:'failed'}).length,0)
})
test('estimated historical cost retains provenance without inventing it for legacy records',()=>{
  const cost={amount:1,currency:'USD',basis:'price-estimate',pricing:{version:'v1',sourceUrl:'https://example.com/prices',effectiveAt:t.startedAt}}
  const checked=validateTaskRecord({...t,calls:[{...t.calls[0],cost}]});assert.deepEqual(checked.calls[0].cost,cost)
  assert.throws(()=>validateTaskRecord({...t,calls:[{...t.calls[0],cost:{...cost,pricing:{...cost.pricing,effectiveAt:t.endedAt}}}]}))
  assert.match(taskCsv([checked],[]),/https:\/\/example.com\/prices/)
  assert.throws(()=>validateTaskRecord({...t,calls:[{...t.calls[0],cost:{...cost,pricing:{...cost.pricing,sourceUrl:'javascript:x'}}}]}))
})
