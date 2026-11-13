import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTs } from './load-ts.mjs'

const {
  analyzeTaskScheduling,
  getTaskPriority,
  withDefaultTaskPriorities,
} = await loadTs('../src/orchestration/taskScheduling.ts')
const { createTaskSession, updateTaskSession } = await loadTs('../src/orchestration/taskSession.ts')
const { validateTaskPlan } = await loadTs('../src/orchestration/taskPlanValidation.ts')
const {
  MapExecutionAdapterRegistry,
  runCoordinationCycle,
} = await loadTs('../src/orchestration/taskCoordinator.ts')
const { MemoryTaskCoordinationStore } = await loadTs('../src/orchestration/TaskCoordinationStore.ts')

const NOW = '2026-11-13T08:00:00.000Z'

const analysisResult = {
  taskType: 'mixed',
  complexity: 'medium',
  estimatedInputTokens: { min: 10, max: 20 },
  estimatedOutputTokens: { min: 50, max: 100 },
  estimationBasis: 'heuristic-metadata',
  assumptions: ['metadata only'],
  optimizedPrompt: 'Complete this plan.',
  promptOptimizationSource: 'local',
  canRunInParallel: true,
  parallelPlan: ['Run independent tasks in parallel.'],
  warnings: [],
}

const task = (id, options = {}) => ({
  id,
  title: `Task ${id}`,
  description: `Complete ${id}.`,
  dependsOn: [],
  recommendedProviderId: 'codex',
  executionMode: 'api',
  prompt: `Complete ${id}.`,
  files: {
    inputs: [],
    readPaths: [],
    allowedWritePaths: [],
    forbiddenPaths: [],
    outputPaths: [],
  },
  expectedDeliverables: [`${id} deliverable`],
  acceptanceChecks: [`${id} accepted`],
  ...options,
})

const plan = (tasks) => ({
  schemaVersion: 1,
  id: 'plan-scheduling',
  title: 'Scheduling plan',
  goal: 'Validate deterministic task scheduling.',
  assumptions: ['Fixtures only.'],
  tasks,
  finalAcceptanceChecks: ['All tasks completed.'],
})

const createSession = (tasks) => {
  const outcome = createTaskSession({
    analysisInput: { prompt: 'Complete this plan.', files: [] },
    analysisResult,
    plan: plan(tasks),
  }, NOW)
  assert.equal(outcome.ok, true, outcome.message)
  return outcome.session
}

const adapter = (calls) => ({
  async dispatch(request) {
    calls.push(request.taskId)
    return {
      ok: true,
      value: {
        dispatchId: request.dispatchId,
        adapterExecutionId: `exec-${request.taskId}`,
        taskId: request.taskId,
        state: 'queued',
        acceptedAt: NOW,
      },
    }
  },
  async inspect(reference) {
    return { ok: true, value: { ...reference, state: 'queued', observedAt: NOW } }
  },
  async cancel(reference) {
    return { ok: true, value: { ...reference, state: 'cancelled', observedAt: NOW } }
  },
})

test('uses medium for legacy task plans and validates only known priorities', () => {
  const legacy = plan([task('legacy')])
  const validated = validateTaskPlan(legacy)
  assert.equal(validated.ok, true)
  assert.equal(getTaskPriority(legacy.tasks[0]), 'medium')
  assert.equal(withDefaultTaskPriorities(legacy).tasks[0].priority, 'medium')
  assert.equal(Object.hasOwn(legacy.tasks[0], 'priority'), false)

  const invalid = structuredClone(legacy)
  invalid.tasks[0].priority = 'urgent'
  const invalidResult = validateTaskPlan(invalid)
  assert.equal(invalidResult.ok, false)
  assert.equal(invalidResult.issues.some(issue => issue.path === 'tasks[0].priority'), true)
})

test('ranks ready tasks by priority, then critical path, then plan order', () => {
  const session = createSession([
    task('medium-short', { priority: 'medium', recommendedProviderId: 'deepseek' }),
    task('medium-long', { priority: 'medium', recommendedProviderId: 'codex' }),
    task('high-short', { priority: 'high', recommendedProviderId: 'doubao' }),
    task('low-short', { priority: 'low', recommendedProviderId: 'local' }),
    task('long-child', { dependsOn: ['medium-long'], executionMode: 'manual' }),
  ])
  const analysis = analyzeTaskScheduling(session)

  assert.deepEqual(analysis.orderedReadyTaskIds, [
    'high-short',
    'medium-long',
    'medium-short',
    'low-short',
  ])
  assert.deepEqual(analysis.criticalPathTaskIds, ['medium-long', 'long-child'])
  assert.deepEqual(
    analysis.insights.find(insight => insight.taskId === 'long-child')?.blockedByTaskIds,
    ['medium-long'],
  )
  assert.equal(analysis.insights.find(insight => insight.taskId === 'medium-long')?.parallelReadyCount, 3)
})

test('uses priority order for automatic dispatch without bypassing concurrency limits', async () => {
  const session = createSession([
    task('low', { priority: 'low', recommendedProviderId: 'local' }),
    task('medium-short', { priority: 'medium', recommendedProviderId: 'deepseek' }),
    task('high', { priority: 'high', recommendedProviderId: 'doubao' }),
    task('medium-long', { priority: 'medium', recommendedProviderId: 'codex' }),
    task('long-child', { dependsOn: ['medium-long'], executionMode: 'manual' }),
  ])
  const calls = []
  const outcome = await runCoordinationCycle({
    session,
    store: new MemoryTaskCoordinationStore(),
    adapters: new MapExecutionAdapterRegistry([
      ['local', adapter(calls)],
      ['deepseek', adapter(calls)],
      ['doubao', adapter(calls)],
      ['codex', adapter(calls)],
    ]),
    now: () => new Date(NOW),
  })

  assert.equal(outcome.ok, true, outcome.error?.message)
  assert.deepEqual(calls, ['high', 'medium-long'])
  assert.equal(outcome.value.state.records.length, 2)
})

test('allows priority edits before any task starts and locks them once execution starts', () => {
  const session = createSession([task('task-1', { executionMode: 'manual' })])
  const editable = updateTaskSession(session, {
    type: 'update-task-definition',
    taskId: 'task-1',
    task: {
      title: 'Task task-1',
      description: 'Complete task-1.',
      prompt: 'Complete task-1.',
      files: session.plan.tasks[0].files,
      expectedDeliverables: ['task-1 deliverable'],
      acceptanceChecks: ['task-1 accepted'],
      priority: 'high',
      recommendedProviderId: 'codex',
    },
  }, NOW)
  assert.equal(editable.ok, true, editable.message)
  assert.equal(editable.session.plan.tasks[0].priority, 'high')

  const started = updateTaskSession(editable.session, { type: 'start', taskId: 'task-1' }, NOW)
  assert.equal(started.ok, true, started.message)
  const locked = updateTaskSession(started.session, {
    type: 'update-task-definition',
    taskId: 'task-1',
    task: {
      title: 'Task task-1',
      description: 'Complete task-1.',
      prompt: 'Complete task-1.',
      files: started.session.plan.tasks[0].files,
      expectedDeliverables: ['task-1 deliverable'],
      acceptanceChecks: ['task-1 accepted'],
      priority: 'low',
      recommendedProviderId: 'codex',
    },
  }, NOW)
  assert.equal(locked.ok, false)
})
