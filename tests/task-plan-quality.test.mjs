import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTs } from './load-ts.mjs'

const { refreshTaskPlanRecommendations, inspectTaskPlanQuality } = await loadTs(
  '../src/orchestration/taskPlanQuality.ts',
)
const { DEFAULT_PROVIDER_PROFILES } = await loadTs('../src/orchestration/providerProfiles.ts')

const scope = () => ({
  inputs: [], readPaths: [], allowedWritePaths: [], forbiddenPaths: [], outputPaths: [],
})
const task = (id, title, dependsOn = []) => ({
  id,
  title,
  description: `${title} with concrete constraints and expected outcomes.`,
  dependsOn,
  recommendedProviderId: 'local',
  executionMode: 'manual',
  prompt: `${title}. Use the dependency outputs, produce the deliverable, and explain verification.`,
  files: scope(),
  expectedDeliverables: [`${title} deliverable`],
  acceptanceChecks: [`Verify the ${title} deliverable against the stated requirements.`],
})
const plan = {
  schemaVersion: 1,
  id: 'quality-plan',
  title: 'Quality plan',
  goal: 'Build and document a feature.',
  assumptions: [],
  tasks: [
    task('analyze', 'Analyze product requirements and design architecture'),
    task('implement', 'Implement React component code and run tests', ['analyze']),
    task('document', 'Write a Chinese user guide', ['implement']),
  ],
  finalAcceptanceChecks: ['All deliverables are consistent.'],
}
const input = {
  analysisInput: { prompt: plan.goal, files: [] },
  analysisResult: {
    taskType: 'mixed', complexity: 'high',
    estimatedInputTokens: { min: 10, max: 20 },
    estimatedOutputTokens: { min: 100, max: 200 },
    estimationBasis: 'heuristic-metadata', assumptions: [], optimizedPrompt: plan.goal,
    promptOptimizationSource: 'local', canRunInParallel: false, parallelPlan: [], warnings: [],
  },
  availableProviders: DEFAULT_PROVIDER_PROFILES,
}

test('remote task content remains stable while local worker recommendations are refreshed', () => {
  const refreshed = refreshTaskPlanRecommendations(plan, input)
  assert.deepEqual(refreshed.tasks.map(item => item.recommendedProviderId), [
    'deepseek', 'codex', 'doubao',
  ])
  assert.deepEqual(refreshed.tasks.map(item => item.providerRecommendation.category), [
    'planning', 'coding', 'writing',
  ])
  for (let index = 0; index < plan.tasks.length; index += 1) {
    const before = plan.tasks[index]
    const after = refreshed.tasks[index]
    assert.equal(after.id, before.id)
    assert.deepEqual(after.dependsOn, before.dependsOn)
    assert.equal(after.prompt, before.prompt)
    assert.deepEqual(after.expectedDeliverables, before.expectedDeliverables)
    assert.deepEqual(after.acceptanceChecks, before.acceptanceChecks)
  }
  assert.equal(plan.tasks[0].recommendedProviderId, 'local')
})

test('quality inspection detects over-fragmentation and meaningless serialization', () => {
  const manyTasks = Array.from({ length: 13 }, (_, index) => task(
    `task-${index + 1}`,
    `Concrete work item ${index + 1}`,
    index === 0 ? [] : [`task-${index}`],
  ))
  const issues = inspectTaskPlanQuality({ ...plan, tasks: manyTasks }, {
    ...input,
    analysisResult: { ...input.analysisResult, canRunInParallel: true },
  })
  assert(issues.some(issue => issue.code === 'OVER_FRAGMENTED'))
  assert(issues.some(issue => issue.code === 'MEANINGLESS_SERIALIZATION'))
})

test('quality inspection detects vague tasks without mutating the plan', () => {
  const vague = { ...plan, tasks: [{ ...task('vague', 'Task'), description: 'Do it.', prompt: 'Continue.' }] }
  const snapshot = structuredClone(vague)
  const issues = inspectTaskPlanQuality(vague, input)
  assert(issues.some(issue => issue.code === 'VAGUE_TASK' && issue.taskId === 'vague'))
  assert.deepEqual(vague, snapshot)
})
