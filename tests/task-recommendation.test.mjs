import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTs } from './load-ts.mjs'

const { recommendTaskProvider } = await loadTs('../src/orchestration/taskRecommendation.ts')
const { DEFAULT_PROVIDER_PROFILES } = await loadTs('../src/orchestration/providerProfiles.ts')
const { validateTaskPlan } = await loadTs('../src/orchestration/taskPlanValidation.ts')

const recommend = (text, overrides = {}) => recommendTaskProvider({
  title: text,
  description: text,
  prompt: text,
  globalTaskType: 'general',
  files: [],
  availableProviders: DEFAULT_PROVIDER_PROFILES,
  ...overrides,
})

test('recommends different providers for planning, coding and writing subtasks', () => {
  const planning = recommend('分析产品需求并设计技术方案')
  const coding = recommend('实现登录组件并修改代码')
  const writing = recommend('撰写面向用户的中文使用说明')

  assert.deepEqual(
    [planning.recommendedProviderId, coding.recommendedProviderId, writing.recommendedProviderId],
    ['deepseek', 'codex', 'doubao'],
  )
  assert.deepEqual(
    [planning.recommendation.category, coding.recommendation.category, writing.recommendation.category],
    ['planning', 'coding', 'writing'],
  )
  assert.ok([planning, coding, writing].every(item => item.recommendation.confidence === 'high'))
})

test('distinguishes test design from executable testing work', () => {
  const design = recommend('设计边界场景测试方案和测试用例')
  const execution = recommend('运行单元测试并修复失败测试')
  const implementation = recommend('编写核心页面代码和测试')

  assert.equal(design.recommendation.category, 'testing')
  assert.equal(design.recommendedProviderId, 'deepseek')
  assert.deepEqual(design.recommendation.requiredCapabilities, ['planning'])
  assert.equal(execution.recommendation.category, 'testing')
  assert.equal(execution.recommendedProviderId, 'codex')
  assert.deepEqual(execution.recommendation.requiredCapabilities, ['testing'])
  assert.equal(implementation.recommendation.category, 'testing')
  assert.equal(implementation.recommendedProviderId, 'codex')
  assert.deepEqual(implementation.recommendation.requiredCapabilities, ['testing'])
})

test('recommends providers consistently for the mixed App example', () => {
  const tasks = [
    '分析一个记账 App 的功能需求',
    '根据需求设计 React 页面结构',
    '编写核心页面代码和测试',
    '撰写一份面向普通用户的使用说明',
  ].map(text => recommend(text, { globalTaskType: 'mixed' }))

  assert.deepEqual(tasks.map(task => task.recommendedProviderId), [
    'deepseek',
    'deepseek',
    'codex',
    'doubao',
  ])

  const implementation = recommend('实现 React 页面结构并创建组件文件')
  assert.equal(implementation.recommendedProviderId, 'codex')
  assert.equal(implementation.recommendation.category, 'coding')
})

test('distinguishes project document edits from content-only writing', () => {
  const fileEdit = recommend('修改 README.md 并更新项目安装步骤')
  const content = recommend('撰写一篇介绍项目用途的中文文案')

  assert.equal(fileEdit.recommendedProviderId, 'codex')
  assert.equal(fileEdit.recommendation.category, 'coding')
  assert.ok(fileEdit.recommendation.requiredCapabilities.includes('file-editing'))
  assert.equal(content.recommendedProviderId, 'doubao')
  assert.equal(content.recommendation.category, 'writing')
})

test('uses attachment metadata only as a supporting signal', () => {
  const image = recommend('处理附件', {
    files: [{ kind: 'attachment', name: 'screen.png', type: 'image/png', size: 120 }],
  })
  const pdf = recommend('处理附件', {
    files: [{ kind: 'attachment', name: 'paper.pdf', type: 'application/pdf', size: 240 }],
  })
  const code = recommend('处理附件', {
    files: [{ kind: 'attachment', name: 'feature.ts', type: 'text/typescript', size: 360 }],
  })

  assert.deepEqual(
    [image.recommendedProviderId, pdf.recommendedProviderId, code.recommendedProviderId],
    ['doubao', 'deepseek', 'codex'],
  )
  assert.deepEqual(
    [image.recommendation.category, pdf.recommendation.category, code.recommendation.category],
    ['vision', 'research', 'coding'],
  )
  assert.ok([image, pdf, code].every(item => item.recommendation.confidence === 'medium'))
})

test('falls back by capability and then to local rules without mutating providers', () => {
  const customProviders = [{
    id: 'custom:dev-helper',
    displayName: '开发助手',
    capabilities: ['coding', 'file-editing'],
    executionModes: ['manual'],
    quotaSupport: 'manual',
  }]
  const before = structuredClone(customProviders)
  const custom = recommend('实现并修改组件代码', { availableProviders: customProviders })
  const local = recommend('检索并核验最新资料', { availableProviders: [] })

  assert.equal(custom.recommendedProviderId, 'custom:dev-helper')
  assert.equal(custom.recommendation.confidence, 'low')
  assert.match(custom.recommendation.reason, /已回退到开发助手/)
  assert.equal(local.recommendedProviderId, 'local')
  assert.match(local.recommendation.reason, /已回退到本地规则/)
  assert.deepEqual(customProviders, before)
})

test('uses the global task type only as a low-confidence fallback', () => {
  const fallback = recommend('完成这一部分', { globalTaskType: 'writing' })
  assert.equal(fallback.recommendedProviderId, 'doubao')
  assert.equal(fallback.recommendation.category, 'writing')
  assert.equal(fallback.recommendation.confidence, 'low')
})

test('strictly validates optional recommendation metadata while accepting old plans', () => {
  const task = {
    id: 'task-1',
    title: '分析需求',
    description: '分析产品需求。',
    dependsOn: [],
    recommendedProviderId: 'deepseek',
    executionMode: 'manual',
    prompt: '分析需求并给出方案。',
    files: { inputs: [], allowedWritePaths: [], forbiddenPaths: [], outputPaths: [] },
    expectedDeliverables: ['需求方案'],
    acceptanceChecks: ['方案覆盖目标'],
  }
  const plan = {
    schemaVersion: 1,
    id: 'recommendation-plan',
    title: '推荐测试计划',
    goal: '验证推荐契约。',
    assumptions: [],
    tasks: [task],
    finalAcceptanceChecks: ['完成全部任务'],
  }

  assert.equal(validateTaskPlan(plan).ok, true)
  const valid = structuredClone(plan)
  valid.tasks[0].providerRecommendation = {
    category: 'planning',
    requiredCapabilities: ['planning'],
    confidence: 'high',
    reason: '任务需要结构化方案设计。',
  }
  assert.equal(validateTaskPlan(valid).ok, true)

  for (const providerRecommendation of [
    { ...valid.tasks[0].providerRecommendation, category: 'unknown' },
    { ...valid.tasks[0].providerRecommendation, confidence: 'certain' },
    { ...valid.tasks[0].providerRecommendation, reason: '' },
    { ...valid.tasks[0].providerRecommendation, requiredCapabilities: [] },
    { ...valid.tasks[0].providerRecommendation, requiredCapabilities: ['planning', 'planning'] },
  ]) {
    const invalid = structuredClone(valid)
    invalid.tasks[0].providerRecommendation = providerRecommendation
    assert.equal(validateTaskPlan(invalid).ok, false)
  }
})
