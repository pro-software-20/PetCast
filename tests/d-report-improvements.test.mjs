import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTs } from './load-ts.mjs'
const { TaskEvidenceAdapter } = await loadTs('../src/reports/taskEvidenceAdapter.ts')
const { createTaskEvaluationRequestFixture } = await loadTs('../src/orchestration/taskEvaluationFixtures.ts')
const { taskInsights } = await loadTs('../src/reports/taskInsights.ts')
const { taskHabits } = await loadTs('../src/reports/taskHabits.ts')

test('duplicate criteria retain the second failure and its repair detail', async () => {
  const req = createTaskEvaluationRequestFixture()
  req.task.acceptanceChecks = ['检查内容', '检查内容']
  req.result.verification = [{label:'检查内容',status:'passed'}, {label:'检查内容',status:'failed',details:'第二份文件缺少活动日期'}]
  req.result.evidence = [0,1].map(i=>({type:'user-review',reference:'check:'+i,summary:'逐项核对'}))
  const report = await new TaskEvidenceAdapter().evaluate(req,new AbortController().signal)
  assert.equal(report.verdict,'revise')
  assert.deepEqual(report.verification.map(v=>v.status),['passed','failed'])
  assert.equal(report.verification[1].details,'第二份文件缺少活动日期')
})

const call = {provider:'P',model:'M',attempt:1,status:'succeeded',usage:{inputTokens:80,outputTokens:20}}
const task = {id:'one',label:'活动通知',category:'写作',status:'succeeded',calls:[call]}
test('advice distinguishes task failure, retries and missing usage with task references', () => {
  const rows = taskInsights([{...task,status:'failed',calls:[call,{...call,attempt:2,usage:null}]}])
  assert.deepEqual(rows.map(r=>r.id),['failed','retry','metering'])
  assert.ok(rows.every(r=>r.taskIds.join()==='one'))
  assert.match(rows[1].evidence,/1 次重试/)
  assert.doesNotMatch(rows[1].evidence,/上报/)
  assert.match(rows[2].evidence,/2 次调用中，1 次/)
})
test('no fabricated advice for empty or successful complete records; zero usage is measured', () => {
  assert.deepEqual(taskInsights([]),[])
  assert.deepEqual(taskInsights([task]),[])
  const rows=taskInsights([{...task,calls:[{...call,attempt:2,usage:{inputTokens:0,outputTokens:0}}]}])
  assert.equal(rows.length,1)
  assert.match(rows[0].evidence,/1 次上报 0 Token/)
})
test('stage totals separate missing usage and multi-AI participation without assuming switches', () => {
  const stats=taskHabits([{...task,calls:[{...call,stage:'planning'}, {...call,model:'M2',stage:'execution',usage:null},call]}])
  assert.equal(stats.multiAiTasks,1)
  assert.deepEqual(stats.stages.map(s=>[s.stage,s.calls,s.measured,s.tokens]),[
    ['planning',1,1,100],['execution',1,0,0],['unknown',1,1,100],
  ])
})
