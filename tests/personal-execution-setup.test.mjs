import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadTs } from './load-ts.mjs'
const { DeepSeekExecutionManager } = await loadTs('../electron/deepSeekExecutionManager.ts')
const { prepareDeepSeekBatch } = await loadTs('../src/orchestration/batchExecutionSetup.ts')
const { createTaskSession, updateTaskSession } = await loadTs('../src/orchestration/taskSession.ts')
const task = (id, dependsOn=[]) => ({ id, title: '撰写方案', description: '撰写活动文案', dependsOn,
  recommendedProviderId: 'doubao', executionMode: 'manual', prompt: '撰写一段活动文案',
  files: { inputs: [], readPaths: [], allowedWritePaths: [], forbiddenPaths: [], outputPaths: [] }, expectedDeliverables: ['文案'], acceptanceChecks: ['包含主题'] })
const input = () => ({ analysisInput: { prompt: '撰写活动方案', files: [] }, analysisResult: {
  taskType: 'writing', complexity: 'medium', estimatedInputTokens: { min: 1, max: 10 }, estimatedOutputTokens: { min: 10, max: 100 },
  estimationBasis: 'heuristic-metadata', assumptions: [], optimizedPrompt: '撰写活动方案', promptOptimizationSource: 'local', canRunInParallel: false, parallelPlan: [], warnings: [],
}, plan: { schemaVersion: 1, id: 'plan-batch', title: '活动方案', goal: '完成文案', assumptions: [], tasks: [task('one'),task('two',['one'])], finalAcceptanceChecks: ['交付文案'] } })

test('batch configures dependent text tasks without dispatching or modifying original', () => {
  const created = createTaskSession(input()); assert.equal(created.ok, true, created.message)
  const before = JSON.stringify(created.session)
  const result = prepareDeepSeekBatch(created.session)
  assert.deepEqual(result.configured, ['one','two'])
  assert.equal(result.session.plan.tasks[1].executionMode, 'api')
  assert.equal(result.session.runs[1].assignedProviderId, 'deepseek')
  assert.deepEqual(result.session.plan.tasks[1].dependsOn, ['one'])
  assert.equal(result.session.runs[1].attempt, 0)
  assert.equal(JSON.stringify(created.session), before)
})

test('batch preserves started tasks and file-writing tasks', () => {
  const data = input(); data.plan.tasks[1].files.allowedWritePaths = ['src/page.ts']
  const created = createTaskSession(data); assert.equal(created.ok, true)
  const started = updateTaskSession(created.session, { type: 'start', taskId: 'one' }); assert.equal(started.ok, true, started.message)
  const result = prepareDeepSeekBatch(started.session)
  assert.equal(result.configured.length, 0)
  assert.equal(result.skipped.length, 2)
})

test('personal connection validates models and keeps secrets out of public state and disk', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'petcast-account-'))
  const calls = []
  const manager = new DeepSeekExecutionManager(path.join(dir, 'executions.json'), { fetchImpl: async (url, init) => {
    calls.push({ url, init }); return new Response(JSON.stringify({ data: [{ id: 'test-model' }] }))
  } })
  try {
    assert.equal(manager.connectionStatus().configured, false)
    assert.equal((await manager.configureAccount('test-secret', 'missing')).ok, false)
    assert.equal(manager.connectionStatus().configured, false)
    const connected = await manager.configureAccount('test-secret', 'test-model')
    assert.equal(connected.ok, true)
    assert.equal(manager.connectionStatus().model, 'test-model')
    assert.doesNotMatch(JSON.stringify({connected, status: manager.connectionStatus()}), /test-secret/)
    assert.ok(calls.every(c => c.url === 'https://api.deepseek.com/models' && !c.init.body))
    const disk = await readFile(path.join(dir,'executions.json'),'utf8').catch(()=>'')
    assert.doesNotMatch(disk, /test-secret|apiKey|authorization/i)
  } finally { await manager.dispose(); await rm(dir,{recursive:true,force:true}) }
})

test('personal planner returns a validated plan using the user account and respects pre-cancellation', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'petcast-personal-plan-'))
  const data = input()
  const planningInput = { prompt: data.analysisInput.prompt, analysis: data.analysisResult, files: [], providers: [
    { id: 'doubao', displayName: '豆包', capabilities: ['text-generation'], executionModes: ['manual'] },
  ] }
  let calls = 0
  const manager = new DeepSeekExecutionManager(path.join(dir,'executions.json'), {
    apiKey: 'test-secret', model: 'test-model', fetchImpl: async (url, options) => {
      calls++
      assert.equal(url, 'https://api.deepseek.com/chat/completions')
      assert.equal(options.headers.authorization, 'Bearer test-secret')
      assert.equal(JSON.parse(options.body).model, 'test-model')
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ plan: data.plan }) } }] }))
    },
  })
  try {
    const cancelled = new AbortController(); cancelled.abort()
    assert.equal((await manager.planWithPersonalAccount(planningInput, cancelled.signal)).ok, false)
    assert.equal(calls,0)
    const result = await manager.planWithPersonalAccount(planningInput, new AbortController().signal)
    assert.equal(result.ok,true,JSON.stringify(result))
    assert.equal(calls,1)
    assert.equal(result.plan.tasks.length,2)
    assert.doesNotMatch(JSON.stringify(result),/test-secret/)
  } finally { await manager.dispose(); await rm(dir,{recursive:true,force:true}) }
})

test('invalid credentials never become configured and network details remain private', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'petcast-account-fail-'))
  const manager = new DeepSeekExecutionManager(path.join(dir,'executions.json'), { fetchImpl: async () => { throw Error('test-secret') } })
  try {
    const result = await manager.configureAccount('test-secret','test-model')
    assert.equal(result.ok,false)
    assert.equal(manager.connectionStatus().configured,false)
    assert.doesNotMatch(JSON.stringify(result),/test-secret/)
  } finally { await manager.dispose(); await rm(dir,{recursive:true,force:true}) }
})
