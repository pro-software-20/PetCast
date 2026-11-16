import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTs } from './load-ts.mjs'

const { createTaskSession } = await loadTs('../src/orchestration/taskSession.ts')
const { reconcileTaskSessionWithCoordination } = await loadTs('../src/orchestration/taskCoordinationSession.ts')
const { MemoryTaskCoordinationStore } = await loadTs('../src/orchestration/TaskCoordinationStore.ts')
const { MemoryTaskAcceptanceStore } = await loadTs('../src/orchestration/TaskAcceptanceStore.ts')
const { createInMemoryTaskEvaluationAdapter } = await loadTs('../src/orchestration/taskEvaluationFixtures.ts')
const {
  createStableTaskEvaluationId,
  requestTaskEvaluation,
} = await loadTs('../src/orchestration/taskEvaluationWorkflow.ts')

const CREATED = '2026-11-08T08:00:00.000Z'
const COMPLETED = '2026-11-08T08:01:00.000Z'

const createFixture = () => {
  const created = createTaskSession({
    analysisInput: { prompt: 'Evaluate a coordinated result.', files: [] },
    analysisResult: {
      taskType: 'analysis',
      complexity: 'medium',
      estimatedInputTokens: { min: 10, max: 20 },
      estimatedOutputTokens: { min: 100, max: 200 },
      estimationBasis: 'heuristic-metadata',
      assumptions: ['metadata only'],
      optimizedPrompt: 'Evaluate the result.',
      promptOptimizationSource: 'local',
      canRunInParallel: false,
      parallelPlan: ['Run serially.'],
      warnings: [],
    },
    plan: {
      schemaVersion: 1,
      id: 'plan-workflow',
      title: 'Evaluation workflow',
      goal: 'Safely evaluate one coordinated result.',
      assumptions: ['D is advisory.'],
      tasks: [{
        id: 'task-1',
        title: 'Review result',
        description: 'Review the safe execution summary.',
        dependsOn: [],
        recommendedProviderId: 'deepseek',
        executionMode: 'api',
        prompt: 'Produce a reviewable result.',
        files: { inputs: [], readPaths: [], allowedWritePaths: [], forbiddenPaths: [], outputPaths: [] },
        expectedDeliverables: ['A structured result'],
        acceptanceChecks: ['The result is structurally valid'],
      }],
      finalAcceptanceChecks: ['The task was reviewed.'],
    },
  }, CREATED)
  assert.equal(created.ok, true, created.message)

  const dispatchId = 'dispatch-workflow-task-1-attempt-1'
  const reference = {
    dispatchId,
    adapterExecutionId: 'adapter-workflow-1',
    taskId: 'task-1',
  }
  const result = {
    taskId: 'task-1',
    providerId: 'deepseek',
    summary: 'The coordinated task completed.',
    outputText: 'Full output remains in the task session and is not sent to D.',
    changedFiles: ['docs/result.md'],
    verification: [{ label: 'The result is structurally valid', status: 'not-run' }],
  }
  const coordinationState = {
    schemaVersion: 1,
    sessionId: created.session.id,
    planId: created.session.plan.id,
    updatedAt: COMPLETED,
    records: [{
      taskId: 'task-1',
      providerId: 'deepseek',
      attempt: 1,
      dispatchId,
      phase: 'completed',
      reference,
      latestSnapshot: { ...reference, state: 'completed', observedAt: COMPLETED, result },
      createdAt: CREATED,
      updatedAt: COMPLETED,
    }],
  }
  const reconciled = reconcileTaskSessionWithCoordination({
    session: created.session,
    coordinationState,
  })
  assert.equal(reconciled.ok, true, reconciled.message)
  assert.equal(reconciled.session.runs[0].status, 'review')
  return { session: reconciled.session, coordinationState, dispatchId }
}

const manualPolicy = { mode: 'manual', trustedMethods: ['rubric'], maxAttempts: 3 }
const trustedPolicy = { mode: 'trusted-evaluation', trustedMethods: ['rubric'], maxAttempts: 3 }

test('evaluation workflow persists before publishing and reuses the stable evaluation', async () => {
  const fixture = createFixture()
  const coordinationStore = new MemoryTaskCoordinationStore(fixture.coordinationState)
  const acceptanceStore = new MemoryTaskAcceptanceStore()
  const delegate = createInMemoryTaskEvaluationAdapter('accepted')
  let calls = 0
  const adapter = {
    async evaluate(request, signal) {
      calls += 1
      return delegate.evaluate(request, signal)
    },
  }

  const first = await requestTaskEvaluation({
    session: fixture.session,
    taskId: 'task-1',
    adapter,
    coordinationStore,
    acceptanceStore,
    policy: manualPolicy,
    signal: new AbortController().signal,
  })
  assert.equal(first.ok, true, first.message)
  assert.equal(first.reused, false)
  assert.equal(first.decision.action, 'manual-review')
  assert.equal(calls, 1)
  assert.equal(acceptanceStore.writes.length, 1)
  assert.equal(first.record.evaluationId, createStableTaskEvaluationId(fixture.dispatchId, 1))

  const second = await requestTaskEvaluation({
    session: fixture.session,
    taskId: 'task-1',
    adapter,
    coordinationStore,
    acceptanceStore,
    policy: manualPolicy,
    signal: new AbortController().signal,
  })
  assert.equal(second.ok, true, second.message)
  assert.equal(second.reused, true)
  assert.equal(calls, 1)
  assert.equal(second.state.records.length, 1)
})

test('evaluation workflow never publishes executable decisions when persistence fails', async () => {
  const fixture = createFixture()
  const adapter = createInMemoryTaskEvaluationAdapter('accepted')
  const failingStore = {
    async load() { return { ok: true, state: null } },
    async save() { return { ok: false, code: 'STORAGE_UNAVAILABLE', message: 'unsafe detail' } },
    async clear() { return { ok: true } },
  }
  const outcome = await requestTaskEvaluation({
    session: fixture.session,
    taskId: 'task-1',
    adapter,
    coordinationStore: new MemoryTaskCoordinationStore(fixture.coordinationState),
    acceptanceStore: failingStore,
    policy: manualPolicy,
    signal: new AbortController().signal,
  })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'STORAGE_FAILED')
  assert.doesNotMatch(outcome.message, /unsafe detail/i)
})

test('pre-cancelled evaluations do not invoke D', async () => {
  const fixture = createFixture()
  let calls = 0
  const controller = new AbortController()
  controller.abort()
  const outcome = await requestTaskEvaluation({
    session: fixture.session,
    taskId: 'task-1',
    adapter: { async evaluate() { calls += 1; throw new Error('must not run') } },
    coordinationStore: new MemoryTaskCoordinationStore(fixture.coordinationState),
    acceptanceStore: new MemoryTaskAcceptanceStore(),
    policy: manualPolicy,
    signal: controller.signal,
  })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'CANCELLED')
  assert.equal(calls, 0)
})

test('trusted evaluation scenarios remain suggestions until the UI applies them', async () => {
  const cases = [
    ['accepted', 'complete'],
    ['revise', 'request-changes'],
    ['unknown', 'manual-review'],
  ]
  for (const [scenario, expectedAction] of cases) {
    const fixture = createFixture()
    const outcome = await requestTaskEvaluation({
      session: fixture.session,
      taskId: 'task-1',
      adapter: createInMemoryTaskEvaluationAdapter(scenario),
      coordinationStore: new MemoryTaskCoordinationStore(fixture.coordinationState),
      acceptanceStore: new MemoryTaskAcceptanceStore(),
      policy: trustedPolicy,
      signal: new AbortController().signal,
    })
    assert.equal(outcome.ok, true, outcome.message)
    assert.equal(outcome.record.report.verdict, scenario)
    assert.equal(outcome.decision.action, expectedAction)
    assert.equal(fixture.session.runs[0].status, 'review')
  }
})

