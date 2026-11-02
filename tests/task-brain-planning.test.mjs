import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTs } from './load-ts.mjs'

const { LocalBrainProvider } = await loadTs('../src/orchestration/LocalBrainProvider.ts')
const { DeepSeekBrainProvider } = await loadTs('../src/orchestration/DeepSeekBrainProvider.ts')
const { createPlanWithTaskBrain } = await loadTs('../src/orchestration/taskBrainPlanning.ts')
const {
  TASK_BRAIN_PREFERENCE_KEY,
  readTaskBrainPreference,
  writeTaskBrainPreference,
} = await loadTs('../src/orchestration/taskBrainPreference.ts')
const { DEFAULT_PROVIDER_PROFILES } = await loadTs('../src/orchestration/providerProfiles.ts')

const input = {
  analysisInput: { prompt: '分析需求并实现功能。', files: [] },
  analysisResult: {
    taskType: 'mixed',
    complexity: 'medium',
    estimatedInputTokens: { min: 10, max: 20 },
    estimatedOutputTokens: { min: 500, max: 1500 },
    estimationBasis: 'heuristic-metadata',
    assumptions: ['仅使用 Prompt 和文件元信息。'],
    optimizedPrompt: '分析需求并实现功能。',
    promptOptimizationSource: 'local',
    canRunInParallel: false,
    parallelPlan: ['按顺序执行。'],
    warnings: [],
  },
  availableProviders: DEFAULT_PROVIDER_PROFILES,
}

const providers = () => ({
  local: new LocalBrainProvider(),
  deepseek: new DeepSeekBrainProvider(),
})

test('local brain creates a sourced plan without calling DeepSeek', async () => {
  let deepSeekCalls = 0
  const set = providers()
  set.deepseek = {
    profile: set.deepseek.profile,
    async createPlan() {
      deepSeekCalls += 1
      return { ok: false, code: 'FAILED', message: 'must not run' }
    },
  }

  const outcome = await createPlanWithTaskBrain('local', input, set)
  assert.equal(outcome.ok, true)
  assert.deepEqual(outcome.plan.planningBrain, {
    requestedBrainId: 'local',
    actualBrainId: 'local',
  })
  assert.equal(deepSeekCalls, 0)
})

test('unconfigured DeepSeek is attempted once and safely falls back to local', async () => {
  let deepSeekCalls = 0
  const set = providers()
  const placeholder = set.deepseek
  set.deepseek = {
    profile: placeholder.profile,
    async createPlan(value, signal) {
      deepSeekCalls += 1
      return placeholder.createPlan(value, signal)
    },
  }

  const outcome = await createPlanWithTaskBrain('deepseek', input, set)
  assert.equal(outcome.ok, true)
  assert.equal(deepSeekCalls, 1)
  assert.deepEqual(outcome.plan.planningBrain, {
    requestedBrainId: 'deepseek',
    actualBrainId: 'local',
    fallbackCode: 'NOT_CONFIGURED',
  })
})

test('cancellation and invalid input do not trigger local fallback', async () => {
  for (const code of ['CANCELLED', 'INVALID_INPUT']) {
    let localCalls = 0
    const set = providers()
    set.local = {
      profile: set.local.profile,
      async createPlan() {
        localCalls += 1
        return { ok: false, code: 'FAILED', message: 'unexpected fallback' }
      },
    }
    set.deepseek = {
      profile: set.deepseek.profile,
      async createPlan() { return { ok: false, code, message: 'safe failure' } },
    }
    const outcome = await createPlanWithTaskBrain('deepseek', input, set)
    assert.equal(outcome.ok, false)
    assert.equal(outcome.code, code)
    assert.equal(localCalls, 0)
  }
})

test('returns the local fallback failure when both brains fail', async () => {
  const set = providers()
  set.local = {
    profile: set.local.profile,
    async createPlan() { return { ok: false, code: 'FAILED', message: '本地任务拆解失败。' } },
  }
  const outcome = await createPlanWithTaskBrain('deepseek', input, set)
  assert.deepEqual(outcome, { ok: false, code: 'FAILED', message: '本地任务拆解失败。' })
})

test('brain preference defaults safely and remembers only valid choices', () => {
  const values = new Map()
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  }
  assert.equal(readTaskBrainPreference(storage), 'local')
  assert.equal(writeTaskBrainPreference('deepseek', storage), true)
  assert.equal(values.get(TASK_BRAIN_PREFERENCE_KEY), 'deepseek')
  assert.equal(readTaskBrainPreference(storage), 'deepseek')
  values.set(TASK_BRAIN_PREFERENCE_KEY, 'broken')
  assert.equal(readTaskBrainPreference(storage), 'local')
  assert.equal(readTaskBrainPreference({ getItem() { throw new Error('denied') }, setItem() {} }), 'local')
})
