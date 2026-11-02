import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTs } from './load-ts.mjs'

const protocol = await loadTs('../electron/taskPlanningProtocol.ts')
const { requestTaskPlan } = await loadTs('../electron/taskPlanningClient.ts')
const { planTasksWithDeepSeek } = await loadTs('../server/deepSeekTaskPlanner.ts')
const { createPromptOptimizationServer } = await loadTs('../server/main.ts')
const { DeepSeekBrainProvider } = await loadTs('../src/orchestration/DeepSeekBrainProvider.ts')
const { createPlanWithTaskBrain } = await loadTs('../src/orchestration/taskBrainPlanning.ts')
const { LocalBrainProvider } = await loadTs('../src/orchestration/LocalBrainProvider.ts')
const { DEFAULT_PROVIDER_PROFILES } = await loadTs('../src/orchestration/providerProfiles.ts')

const installId = '123e4567-e89b-42d3-a456-426614174000'
const analysis = {
  taskType: 'mixed',
  complexity: 'medium',
  estimatedInputTokens: { min: 20, max: 40 },
  estimatedOutputTokens: { min: 500, max: 1500 },
  estimationBasis: 'heuristic-metadata',
  assumptions: ['仅使用 Prompt 和元信息。'],
  optimizedPrompt: '分析需求并实现功能。',
  promptOptimizationSource: 'local',
  canRunInParallel: true,
  parallelPlan: ['分析和写作可以并行。'],
  warnings: [],
}
const request = {
  prompt: '分析需求，实现代码，并撰写说明。',
  analysis,
  files: [{ name: 'requirements.md', type: 'text/markdown', size: 120 }],
  providers: DEFAULT_PROVIDER_PROFILES.map(({ id, displayName, capabilities, executionModes }) => ({
    id, displayName, capabilities, executionModes,
  })),
}
const validPlan = {
  schemaVersion: 1,
  id: 'deepseek-plan-1',
  title: '任务方案',
  goal: request.prompt,
  assumptions: ['附件仅包含元信息。'],
  tasks: [
    {
      id: 'task-1',
      title: '分析需求',
      description: '整理目标和约束。',
      dependsOn: [],
      recommendedProviderId: 'deepseek',
      executionMode: 'manual',
      prompt: '请分析需求并输出结构化结论。',
      files: {
        inputs: [{ kind: 'attachment', ...request.files[0] }],
        readPaths: [],
        allowedWritePaths: [],
        forbiddenPaths: [],
        outputPaths: [],
      },
      expectedDeliverables: ['需求分析结论。'],
      acceptanceChecks: ['结论覆盖目标和约束。'],
    },
    {
      id: 'task-2',
      title: '实现功能',
      description: '根据分析结果实现功能。',
      dependsOn: ['task-1'],
      recommendedProviderId: 'codex',
      executionMode: 'manual',
      prompt: '根据前置结论实现功能并给出验证结果。',
      files: {
        inputs: [],
        readPaths: [],
        allowedWritePaths: [],
        forbiddenPaths: [],
        outputPaths: [],
      },
      expectedDeliverables: ['实现说明。'],
      acceptanceChecks: ['实现结果可以验证。'],
    },
  ],
  finalAcceptanceChecks: ['确认两个子任务均已完成。'],
}

test('task planning request accepts metadata only and rejects secret fields', () => {
  assert.deepEqual(protocol.sanitizeTaskPlanningRequest(request), request)
  assert.equal(protocol.sanitizeTaskPlanningRequest({
    ...request,
    files: [{ ...request.files[0], content: 'private contents' }],
  }), null)
  assert.equal(protocol.sanitizeTaskPlanningRequest({ ...request, workspacePath: 'C:/private' }), null)
})

test('remote task plans allow a valid DAG and reject unsafe authority', () => {
  assert.deepEqual(protocol.sanitizeRemoteTaskPlan(validPlan, request), validPlan)
  assert.equal(protocol.sanitizeRemoteTaskPlan({ ...validPlan, workspace: { id: 'x' } }, request), null)
  assert.equal(protocol.sanitizeRemoteTaskPlan({
    ...validPlan,
    tasks: validPlan.tasks.map((task, index) => index ? { ...task, recommendedProviderId: 'unknown' } : task),
  }, request), null)
  assert.equal(protocol.sanitizeRemoteTaskPlan({
    ...validPlan,
    tasks: validPlan.tasks.map((task, index) => ({
      ...task,
      dependsOn: [index ? 'task-1' : 'task-2'],
    })),
  }, request), null)
  assert.equal(protocol.sanitizeRemoteTaskPlan({
    ...validPlan,
    tasks: [{
      ...validPlan.tasks[0],
      files: { ...validPlan.tasks[0].files, readPaths: ['src/private.ts'] },
    }],
  }, request), null)
})

test('DeepSeek planner sends bounded metadata and accepts a validated task graph', async () => {
  let upstreamBody
  const result = await planTasksWithDeepSeek(request, {
    apiKey: 'test-key',
    fetchImpl: async (_url, init) => {
      upstreamBody = JSON.parse(init.body)
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ plan: validPlan }) } }],
      }), { status: 200 })
    },
  })
  assert.deepEqual(result, { ok: true, plan: validPlan, provider: 'deepseek' })
  assert.equal(upstreamBody.model, 'deepseek-flash')
  assert.deepEqual(upstreamBody.thinking, { type: 'disabled' })
  assert.deepEqual(upstreamBody.response_format, { type: 'json_object' })
  const payload = JSON.parse(upstreamBody.messages[1].content)
  assert.deepEqual(payload.fileMetadata, request.files)
  assert.equal(JSON.stringify(payload).includes('private contents'), false)
  assert.equal(JSON.stringify(payload).includes('workspacePath'), false)
})

test('DeepSeek planner rejects malformed and unsafe model output', async () => {
  const run = content => planTasksWithDeepSeek(request, {
    apiKey: 'test-key',
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 }),
  })
  assert.deepEqual(await run('not-json'), { ok: false, code: 'INVALID_RESPONSE' })
  assert.deepEqual(await run(JSON.stringify({ plan: { ...validPlan, workspace: { id: 'forged' } } })), {
    ok: false, code: 'INVALID_RESPONSE',
  })
  assert.deepEqual(await run(JSON.stringify({ plan: validPlan, answer: 'extra' })), {
    ok: false, code: 'INVALID_RESPONSE',
  })
})

test('Electron planning client permits HTTPS and loopback HTTP only', async () => {
  const success = { ok: true, plan: validPlan, provider: 'deepseek' }
  let called = 0
  const fetchImpl = async () => {
    called += 1
    return new Response(JSON.stringify(success), { status: 200 })
  }
  assert.deepEqual(await requestTaskPlan(request, {
    endpoint: 'http://127.0.0.1:8787', installId, fetchImpl,
  }), success)
  assert.deepEqual(await requestTaskPlan(request, {
    endpoint: 'http://example.com', installId, fetchImpl,
  }), { ok: false, code: 'UPSTREAM_UNAVAILABLE' })
  assert.equal(called, 1)
})

const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => resolve(server.address().port))
})
const close = server => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))

test('AI service exposes the planning route with shared rate limiting', async () => {
  let received
  const server = createPromptOptimizationServer({
    limiter: { consume: async () => ({ allowed: true }) },
    optimize: async () => ({ ok: false, code: 'UPSTREAM_UNAVAILABLE' }),
    plan: async input => {
      received = input
      return { ok: true, plan: validPlan, provider: 'deepseek' }
    },
  })
  const port = await listen(server)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/task/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-petcast-install-id': installId },
      body: JSON.stringify(request),
    })
    assert.equal(response.status, 200)
    assert.deepEqual(received, request)
    assert.deepEqual(await response.json(), { ok: true, plan: validPlan, provider: 'deepseek' })
  } finally {
    await close(server)
  }
})

test('DeepSeekBrainProvider uses one named bridge call and supports cancellation', async () => {
  const calls = []
  const bridge = {
    async planTaskWithDeepSeek(value) {
      calls.push(['plan', value])
      return { ok: true, plan: validPlan, provider: 'deepseek' }
    },
    cancelDeepSeekTaskPlan(id) { calls.push(['cancel', id]) },
  }
  const provider = new DeepSeekBrainProvider(bridge)
  const input = {
    analysisInput: { prompt: request.prompt, files: request.files },
    analysisResult: analysis,
    availableProviders: DEFAULT_PROVIDER_PROFILES,
  }
  const result = await provider.createPlan(input)
  assert.equal(result.ok, true)
  assert.equal(calls.filter(call => call[0] === 'plan').length, 1)
  const serialized = JSON.stringify(calls[0][1])
  assert.equal(serialized.includes('quotaSupport'), false)
  assert.equal(serialized.includes('workspace'), false)

  let resolve
  const pending = new DeepSeekBrainProvider({
    planTaskWithDeepSeek: () => new Promise(done => { resolve = done }),
    cancelDeepSeekTaskPlan: id => calls.push(['cancel', id]),
  })
  const controller = new AbortController()
  const promise = pending.createPlan(input, controller.signal)
  controller.abort()
  resolve({ ok: false, code: 'UPSTREAM_UNAVAILABLE' })
  assert.equal((await promise).code, 'CANCELLED')
  assert.equal(calls.filter(call => call[0] === 'cancel').length, 1)
})

test('DeepSeekBrainProvider maps bounded service errors without exposing upstream details', async () => {
  const input = {
    analysisInput: { prompt: request.prompt, files: request.files },
    analysisResult: analysis,
    availableProviders: DEFAULT_PROVIDER_PROFILES,
  }
  const mappings = [
    ['INVALID_REQUEST', 'INVALID_INPUT'],
    ['RATE_LIMITED', 'RATE_LIMITED'],
    ['UPSTREAM_TIMEOUT', 'TIMEOUT'],
    ['UPSTREAM_UNAVAILABLE', 'UNAVAILABLE'],
    ['INVALID_RESPONSE', 'INVALID_RESPONSE'],
  ]
  for (const [serviceCode, brainCode] of mappings) {
    const provider = new DeepSeekBrainProvider({
      planTaskWithDeepSeek: async () => ({ ok: false, code: serviceCode, debug: 'private upstream body' }),
      cancelDeepSeekTaskPlan() {},
    })
    const outcome = await provider.createPlan(input)
    assert.equal(outcome.ok, false)
    assert.equal(outcome.code, brainCode)
    assert.equal(JSON.stringify(outcome).includes('private upstream body'), false)
  }
})

test('invalid remote plan falls back once and records the actual local brain', async () => {
  let calls = 0
  const input = {
    analysisInput: { prompt: request.prompt, files: request.files },
    analysisResult: analysis,
    availableProviders: DEFAULT_PROVIDER_PROFILES,
  }
  const outcome = await createPlanWithTaskBrain('deepseek', input, {
    local: new LocalBrainProvider(),
    deepseek: {
      profile: { id: 'deepseek', displayName: 'DeepSeek', mode: 'remote' },
      async createPlan() {
        calls += 1
        return { ok: false, code: 'INVALID_RESPONSE', message: 'invalid' }
      },
    },
  })
  assert.equal(outcome.ok, true)
  assert.equal(calls, 1)
  assert.deepEqual(outcome.plan.planningBrain, {
    requestedBrainId: 'deepseek',
    actualBrainId: 'local',
    fallbackCode: 'INVALID_RESPONSE',
  })
})
