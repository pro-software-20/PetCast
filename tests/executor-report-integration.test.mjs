import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {loadTs} from './load-ts.mjs'
const {TaskExecutionRecorder}=await loadTs('../src/history/TaskExecutionRecorder.ts')
const {FileTaskLedger}=await loadTs('../electron/taskLedgerStore.ts')
const {applyTaskEvaluations}=await loadTs('../electron/taskEvaluations.ts')
const {recommendationQuery}=await loadTs('../src/history/recommendationHistory.ts')
const {recommendTaskPlan}=await loadTs('../src/reports/unifiedPlanner.ts')
test('executor boundary -> persisted usage -> later quality reviews -> model/time plan',async()=>{
  let clock=Date.parse('2026-10-22T01:00:00.000Z'),calls=0
  const scope={source:'mock',scopeId:'mock-integration'},file=path.join(await mkdtemp(path.join(tmpdir(),'petcast-integration-')),'ledger.json'),ledger=new FileTaskLedger(file,()=>clock)
  for(let i=0;i<3;i++){
    const id=`run-${i}`,recorder=new TaskExecutionRecorder(ledger,{...scope,id,label:'接口验收',category:'summary'},()=>clock)
    const value=await recorder.call({id:`call-${i}`,provider:'fixture',model:'tested',attempt:1},async()=>{calls++;clock+=60000;return {value:'output',usage:{inputTokens:100,outputTokens:20,cachedInputTokens:0,basis:'provider-reported'},cost:{amount:.01,currency:'USD',basis:'provider-reported'}}})
    assert.equal(value,'output');await recorder.finish('succeeded');clock+=1000
    await ledger.appendTaskEvaluations([{...scope,id:`eval-${i}`,taskId:id,createdAt:new Date(clock).toISOString(),supersedes:null,comparisonKey:'small',rubricVersion:'v1',method:'user',verdict:'accepted',note:''}])
  }
  clock+=1000
  const reopened=new FileTaskLedger(file,()=>clock),query=recommendationQuery(scope,90,clock)
  const raw=await reopened.queryTaskRecords(query),evaluations=await reopened.queryTaskEvaluations(query)
  assert.equal(raw.length,3);assert.equal(raw[0].evaluation,undefined);assert.equal(calls,3)
  const plan=recommendTaskPlan({...scope,category:'summary',comparisonKey:'small',rubricVersion:'v1',method:'user',deadlineAt:new Date(clock+3600000).toISOString(),priority:'normal',allowWait:false,budget:null},applyTaskEvaluations(raw,evaluations),[{...scope,provider:'fixture',model:'tested',enabled:true,preference:1,checkedAt:new Date(clock).toISOString(),basis:'user-confirmed',capacity:{kind:'money',remaining:1,currency:'USD'}}],clock)
  assert.equal(plan.state,'ready');assert.equal(plan.recommendation.model,'tested');assert.equal(plan.recommendation.sampleCount,3)
  assert.equal(plan.recommendation.tokenEstimate,120)
})
