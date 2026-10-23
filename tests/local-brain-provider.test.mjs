import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTs } from './load-ts.mjs'

const { LocalBrainProvider } = await loadTs('../src/orchestration/LocalBrainProvider.ts')
const { buildManualTaskPrompt } = await loadTs('../src/orchestration/manualTaskPrompt.ts')
const { DEFAULT_PROVIDER_PROFILES } = await loadTs('../src/orchestration/providerProfiles.ts')
const { validateTaskPlan } = await loadTs('../src/orchestration/taskPlanValidation.ts')

const analysisResult = (taskType, overrides = {}) => ({
  taskType,
  complexity: 'medium',
  estimatedInputTokens: { min: 10, max: 20 },
  estimatedOutputTokens: { min: 500, max: 1500 },
  estimationBasis: 'heuristic-metadata',
  assumptions: ['仅使用 Prompt 和文件元信息。'],
  optimizedPrompt: '请完成经过本地优化的任务要求。',
  promptOptimizationSource: 'local',
  canRunInParallel: false,
  parallelPlan: ['按顺序执行。'],
  warnings: [],
  ...overrides,
})

const planningInput = (taskType, overrides = {}) => ({
  analysisInput: {
    prompt: '请完成这个任务',
    files: [],
  },
  analysisResult: analysisResult(taskType),
  availableProviders: DEFAULT_PROVIDER_PROFILES,
  ...overrides,
})

const createPlan = async (taskType, overrides = {}) => {
  const outcome = await new LocalBrainProvider().createPlan(planningInput(taskType, overrides))
  assert.equal(outcome.ok, true)
  assert.equal(validateTaskPlan(outcome.plan).ok, true)
  return outcome.plan
}

test('splits numbered tasks into independent roots by default', async () => {
  const plan = await createPlan('mixed', {
    analysisInput: {
      prompt: '1. 分析需求\n2. 编写实现\n3. 撰写使用说明',
      files: [],
    },
  })

  assert.equal(plan.tasks.length, 3)
  assert.deepEqual(plan.tasks.map(task => task.dependsOn), [[], [], []])
  assert.deepEqual(plan.tasks.map(task => task.recommendedProviderId), ['deepseek', 'codex', 'doubao'])
})

test('connects numbered tasks when the prompt contains an explicit dependency', async () => {
  const plan = await createPlan('mixed', {
    analysisInput: {
      prompt: '1. 先分析需求\n2. 完成后实现代码\n3. 然后执行测试',
      files: [],
    },
  })

  assert.deepEqual(plan.tasks.map(task => task.dependsOn), [[], ['task-1'], ['task-2']])
})

test('applies dependencies per task while preserving independent parallel branches', async () => {
  const plan = await createPlan('mixed', {
    analysisInput: {
      prompt: [
        '1. 分析需求',
        '2. 完成任务 1 后实现代码',
        '3. 同时独立撰写使用说明',
        '4. 汇总任务 2 和任务 3 的结果',
      ].join('\n'),
      files: [],
    },
  })

  assert.deepEqual(plan.tasks.map(task => task.dependsOn), [
    [],
    ['task-1'],
    [],
    ['task-2', 'task-3'],
  ])
})

test('uses conservative templates for broad task categories', async () => {
  const cases = [
    ['coding', 3, ['deepseek', 'codex', 'codex']],
    ['research', 3, ['deepseek', 'deepseek', 'deepseek']],
    ['writing', 3, ['deepseek', 'doubao', 'doubao']],
    ['testing', 2, ['codex', 'codex']],
    ['mixed', 3, ['deepseek', 'deepseek', 'deepseek']],
    ['analysis', 1, ['deepseek']],
    ['general', 1, ['deepseek']],
  ]

  for (const [taskType, expectedCount, expectedProviders] of cases) {
    const plan = await createPlan(taskType)
    assert.equal(plan.tasks.length, expectedCount, taskType)
    assert.deepEqual(plan.tasks.map(task => task.recommendedProviderId), expectedProviders, taskType)
    assert.ok(plan.tasks.every(task => task.executionMode === 'manual'), taskType)
    assert.deepEqual(
      plan.tasks.map(task => task.dependsOn),
      plan.tasks.map((_, index) => index === 0 ? [] : [`task-${index}`]),
      taskType,
    )
  }
})

test('falls back to local when no matching manual provider is available', async () => {
  const plan = await createPlan('coding', { availableProviders: [] })
  assert.ok(plan.tasks.every(task => task.recommendedProviderId === 'local'))
})

test('copies attachment metadata without content or fabricated workspace paths', async () => {
  const input = planningInput('research', {
    analysisInput: {
      prompt: '调研附件中的主题',
      files: [{ name: '资料.pdf', type: 'application/pdf', size: 2048, content: 'secret' }],
    },
  })
  const before = structuredClone(input)
  const outcome = await new LocalBrainProvider().createPlan(input)

  assert.equal(outcome.ok, true)
  assert.deepEqual(input, before)
  for (const task of outcome.plan.tasks) {
    assert.deepEqual(task.files.inputs, [
      { kind: 'attachment', name: '资料.pdf', type: 'application/pdf', size: 2048 },
    ])
    assert.deepEqual(task.files.allowedWritePaths, [])
    assert.deepEqual(task.files.forbiddenPaths, [])
    assert.deepEqual(task.files.outputPaths, [])
    assert.equal(JSON.stringify(task.files).includes('secret'), false)
    assert.equal(task.files.inputs.some(file => file.kind === 'workspace'), false)
  }
})

test('returns structured cancellation, invalid-input, invalid-response and failure outcomes', async () => {
  const provider = new LocalBrainProvider()
  const controller = new AbortController()
  controller.abort()

  assert.deepEqual(
    await provider.createPlan(planningInput('general'), controller.signal),
    { ok: false, code: 'CANCELLED', message: '任务拆解已取消。' },
  )

  const invalid = await provider.createPlan(null)
  assert.equal(invalid.ok, false)
  assert.equal(invalid.code, 'INVALID_INPUT')

  const invalidResponse = await provider.createPlan(planningInput('general', {
    analysisResult: analysisResult('general', { assumptions: [''] }),
  }))
  assert.equal(invalidResponse.ok, false)
  assert.equal(invalidResponse.code, 'INVALID_RESPONSE')

  const throwingResult = analysisResult('general')
  Object.defineProperty(throwingResult, 'assumptions', {
    get() { throw new Error('private provider details') },
  })
  const failed = await provider.createPlan(planningInput('general', { analysisResult: throwingResult }))
  assert.equal(failed.ok, false)
  assert.equal(failed.code, 'FAILED')
  assert.equal(failed.message.includes('private provider details'), false)
})

test('uses the optimized prompt directly for a single general task', async () => {
  const optimizedPrompt = '请先说明假设，再回答用户的问题。'
  const plan = await createPlan('general', {
    analysisResult: analysisResult('general', { optimizedPrompt }),
  })
  assert.equal(plan.tasks[0].prompt, optimizedPrompt)
})

test('builds distinct provider prompts with dependencies and safety boundaries', async () => {
  const plan = await createPlan('coding', {
    analysisInput: {
      prompt: '实现一个功能',
      files: [{ name: '需求.txt', type: 'text/plain', size: 128 }],
    },
  })
  const task = plan.tasks[1]
  const prompts = Object.fromEntries(
    ['codex', 'deepseek', 'doubao', 'local'].map(providerId => [
      providerId,
      buildManualTaskPrompt(task, plan, providerId),
    ]),
  )

  assert.equal(new Set(Object.values(prompts)).size, 4)
  for (const prompt of Object.values(prompts)) {
    assert.match(prompt, /前置依赖/)
    assert.match(prompt, /需求\.txt/)
    assert.match(prompt, /仅有元信息/)
    assert.match(prompt, /未授权直接修改/)
    assert.match(prompt, /未指定输出位置/)
    assert.match(prompt, /应交付/)
    assert.match(prompt, /验收标准/)
  }
  assert.match(prompts.codex, /diff/)
  assert.match(prompts.deepseek, /事实、推断和不确定信息/)
  assert.match(prompts.doubao, /清晰自然的中文/)
  assert.match(prompts.local, /人工执行清单/)
})
