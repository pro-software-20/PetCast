import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTs } from './load-ts.mjs'

const {
  reconcileTaskSessionWithCoordination,
  reconcileAndSaveTaskSessionWithCoordination,
} = await loadTs('../src/orchestration/taskCoordinationSession.ts')
const { createTaskSession, updateTaskSession } = await loadTs('../src/orchestration/taskSession.ts')

const NOW = '2026-11-05T08:00:00.000Z'
const NEXT = '2026-11-05T08:00:03.000Z'

const analysisResult = {
  taskType: 'mixed',
  complexity: 'medium',
  estimatedInputTokens: { min: 10, max: 20 },
  estimatedOutputTokens: { min: 100, max: 200 },
  estimationBasis: 'heuristic-metadata',
  assumptions: ['metadata only'],
  optimizedPrompt: 'Complete the tasks.',
  promptOptimizationSource: 'local',
  canRunInParallel: true,
  parallelPlan: ['Run independent tasks in parallel.'],
  warnings: [],
}

const task = (id, providerId = 'deepseek', executionMode = 'api', dependsOn = []) => ({
  id,
  title: `Task ${id}`,
  description: `Execute ${id}`,
  dependsOn,
  recommendedProviderId: providerId,
  executionMode,
  prompt: `Complete ${id}`,
  files: {
    inputs: [],
    readPaths: [],
    allowedWritePaths: [],
    forbiddenPaths: [],
    outputPaths: [],
  },
  expectedDeliverables: [`${id} result`],
  acceptanceChecks: [`${id} accepted`],
})

const createSession = (tasks = [task('task-1')]) => {
  const created = createTaskSession({
    analysisInput: { prompt: 'Complete the tasks.', files: [] },
    analysisResult,
    plan: {
      schemaVersion: 1,
      id: 'plan-reconcile',
      title: 'Coordination reconciliation plan',
      goal: 'Reconcile durable adapter state.',
      assumptions: ['Adapters return safe structured results.'],
      tasks,
      finalAcceptanceChecks: ['All tasks completed.'],
    },
  }, NOW)
  assert.equal(created.ok, true, created.message)
  return created.session
}

const reference = (taskId, dispatchId) => ({
  dispatchId,
  adapterExecutionId: `adapter-${dispatchId}`,
  taskId,
})

const result = (taskId = 'task-1', providerId = 'deepseek') => ({
  taskId,
  providerId,
  summary: `Summary for ${taskId}`,
  changedFiles: ['docs/result.md'],
  verification: [{ label: `${taskId} accepted`, status: 'not-run' }],
})

const record = (phase, options = {}) => {
  const taskId = options.taskId ?? 'task-1'
  const providerId = options.providerId ?? 'deepseek'
  const attempt = options.attempt ?? 1
  const dispatchId = options.dispatchId ?? `dispatch-${taskId}-${attempt}`
  const ref = reference(taskId, dispatchId)
  const value = {
    taskId,
    providerId,
    attempt,
    dispatchId,
    phase,
    createdAt: NOW,
    updatedAt: NEXT,
  }
  if (phase !== 'dispatching' && options.withReference !== false) value.reference = ref
  if (options.snapshot) value.latestSnapshot = options.snapshot
  if (options.error) value.error = options.error
  return value
}

const state = (session, records) => ({
  schemaVersion: 1,
  sessionId: session.id,
  planId: session.plan.id,
  updatedAt: NEXT,
  records,
})

const snapshot = (phase, taskId = 'task-1', dispatchId = 'dispatch-task-1-1', extra = {}) => ({
  ...reference(taskId, dispatchId),
  state: phase,
  observedAt: NEXT,
  ...extra,
})

const run = (session, taskId = 'task-1') => session.runs.find(item => item.taskId === taskId)

test('queued and running coordination start a task exactly once', () => {
  const session = createSession()
  const queued = record('queued')
  const first = reconcileTaskSessionWithCoordination({
    session,
    coordinationState: state(session, [queued]),
  })
  assert.equal(first.ok, true, first.message)
  assert.equal(first.changed, true)
  assert.equal(run(first.session).status, 'running')
  assert.equal(run(first.session).executionMode, 'api')
  assert.equal(run(first.session).attempt, 1)

  const repeated = reconcileTaskSessionWithCoordination({
    session: first.session,
    coordinationState: state(first.session, [queued]),
  })
  assert.equal(repeated.ok, true, repeated.message)
  assert.equal(repeated.changed, false)
  assert.equal(run(repeated.session).attempt, 1)

  const runningRecord = record('running', {
    snapshot: snapshot('running'),
  })
  const running = reconcileTaskSessionWithCoordination({
    session: repeated.session,
    coordinationState: state(repeated.session, [runningRecord]),
  })
  assert.equal(running.ok, true, running.message)
  assert.equal(run(running.session).status, 'running')
  assert.equal(run(running.session).attempt, 1)
})

test('completed execution writes a safe result and stops at manual review', () => {
  const session = createSession()
  const executionResult = result()
  const completed = record('completed', {
    snapshot: snapshot('completed', 'task-1', 'dispatch-task-1-1', { result: executionResult }),
  })
  const outcome = reconcileTaskSessionWithCoordination({
    session,
    coordinationState: state(session, [completed]),
  })
  assert.equal(outcome.ok, true, outcome.message)
  assert.equal(run(outcome.session).status, 'review')
  assert.equal(run(outcome.session).attempt, 1)
  assert.equal(run(outcome.session).draft.outputText, executionResult.summary)
  assert.deepEqual(run(outcome.session).draft.verification, executionResult.verification)
  assert.deepEqual(run(outcome.session).result, { ...executionResult, outputText: executionResult.summary })
  assert.equal(outcome.session.completedAt, undefined)
})

test('needs-input resumes to running and terminal failures map safely', () => {
  const session = createSession()
  const needsInput = record('needs-input', {
    snapshot: snapshot('needs-input', 'task-1', 'dispatch-task-1-1', {
      error: { code: 'NEEDS_INPUT', retryable: false, message: 'Need a decision.' },
    }),
  })
  const waiting = reconcileTaskSessionWithCoordination({
    session,
    coordinationState: state(session, [needsInput]),
  })
  assert.equal(waiting.ok, true, waiting.message)
  assert.equal(run(waiting.session).status, 'needs-input')

  const runningRecord = record('running', { snapshot: snapshot('running') })
  const resumed = reconcileTaskSessionWithCoordination({
    session: waiting.session,
    coordinationState: state(waiting.session, [runningRecord]),
  })
  assert.equal(resumed.ok, true, resumed.message)
  assert.equal(run(resumed.session).status, 'running')

  for (const [phase, expected] of [['failed', 'failed'], ['cancelled', 'cancelled']]) {
    const fresh = createSession()
    const error = phase === 'failed'
      ? { code: 'FAILED', retryable: false, message: 'Adapter failed.' }
      : { code: 'CANCELLED', retryable: false, message: 'Cancelled.' }
    const terminal = record(phase, {
      snapshot: snapshot(phase, 'task-1', 'dispatch-task-1-1', { error }),
    })
    const outcome = reconcileTaskSessionWithCoordination({
      session: fresh,
      coordinationState: state(fresh, [terminal]),
    })
    assert.equal(outcome.ok, true, outcome.message)
    assert.equal(run(outcome.session).status, expected)
    assert.equal(run(outcome.session).attempt, 1)
  }
})

test('unknown execution requires manual review and is never redispatched', () => {
  const session = createSession()
  const error = { code: 'EXECUTION_NOT_FOUND', retryable: false, message: 'Execution state is unknown.' }
  const unknown = record('unknown', {
    snapshot: snapshot('unknown', 'task-1', 'dispatch-task-1-1', { error }),
  })
  const outcome = reconcileTaskSessionWithCoordination({
    session,
    coordinationState: state(session, [unknown]),
  })
  assert.equal(outcome.ok, true, outcome.message)
  assert.equal(run(outcome.session).status, 'needs-input')
  assert.equal(run(outcome.session).attempt, 1)
  assert.ok(outcome.notices.some(item => item.code === 'MANUAL_REVIEW_REQUIRED'))
})

test('dispatching without a receipt never fabricates a running task', () => {
  const session = createSession()
  const outcome = reconcileTaskSessionWithCoordination({
    session,
    coordinationState: state(session, [record('dispatching')]),
  })
  assert.equal(outcome.ok, true, outcome.message)
  assert.equal(outcome.changed, false)
  assert.equal(run(outcome.session).status, 'ready')
  assert.equal(run(outcome.session).attempt, 0)
  assert.ok(outcome.notices.some(item => item.code === 'PRE_DISPATCH_BLOCKED'))
})

test('durable state restores a session without transient effects', () => {
  const session = createSession()
  const completed = record('completed', {
    snapshot: snapshot('completed', 'task-1', 'dispatch-task-1-1', { result: result() }),
  })
  const outcome = reconcileTaskSessionWithCoordination({
    session,
    coordinationState: state(session, [completed]),
  })
  assert.equal(outcome.ok, true, outcome.message)
  assert.equal(run(outcome.session).status, 'review')
})

test('storage failure returns the original session and recovery remains possible', async () => {
  const session = createSession()
  const queued = record('queued')
  const store = {
    async save() { return { ok: false, code: 'STORAGE_UNAVAILABLE', message: 'Storage unavailable.' } },
  }
  const failed = await reconcileAndSaveTaskSessionWithCoordination({
    session,
    coordinationState: state(session, [queued]),
    store,
  })
  assert.equal(failed.ok, false)
  assert.equal(failed.code, 'STORAGE_FAILED')
  assert.deepEqual(failed.session, session)

  const recovered = reconcileTaskSessionWithCoordination({
    session,
    coordinationState: state(session, [queued]),
  })
  assert.equal(recovered.ok, true, recovered.message)
  assert.equal(run(recovered.session).status, 'running')
})

test('provider, attempt, result identity, checks and paths are strictly matched', () => {
  const session = createSession()

  const providerMismatch = record('queued', { providerId: 'codex' })
  assert.equal(reconcileTaskSessionWithCoordination({
    session, coordinationState: state(session, [providerMismatch]),
  }).code, 'STATE_MISMATCH')

  const skippedAttempt = record('queued', { attempt: 2 })
  assert.equal(reconcileTaskSessionWithCoordination({
    session, coordinationState: state(session, [skippedAttempt]),
  }).code, 'STATE_MISMATCH')

  for (const invalidResult of [
    { ...result(), taskId: 'task-other' },
    { ...result(), providerId: 'codex' },
    { ...result(), verification: [{ label: 'wrong check', status: 'passed' }] },
    { ...result(), changedFiles: ['C:/secret.txt'] },
    { ...result(), supplierResponse: 'raw private response' },
  ]) {
    const completed = record('completed', {
      snapshot: snapshot('completed', 'task-1', 'dispatch-task-1-1', { result: invalidResult }),
    })
    const outcome = reconcileTaskSessionWithCoordination({
      session,
      coordinationState: state(session, [completed]),
    })
    assert.equal(outcome.ok, false)
  }
})

test('late old attempts and conflicting terminal results cannot overwrite current data', () => {
  let session = createSession()
  let updated = updateTaskSession(session, { type: 'start', taskId: 'task-1' }, NEXT)
  assert.equal(updated.ok, true, updated.message)
  session = updated.session
  updated = updateTaskSession(session, { type: 'fail', taskId: 'task-1', message: 'manual failure' }, NEXT)
  assert.equal(updated.ok, true, updated.message)
  session = updated.session
  updated = updateTaskSession(session, { type: 'retry', taskId: 'task-1' }, NEXT)
  assert.equal(updated.ok, true, updated.message)
  session = updated.session

  const stale = record('completed', {
    attempt: 1,
    snapshot: snapshot('completed', 'task-1', 'dispatch-task-1-1', { result: result() }),
  })
  const ignored = reconcileTaskSessionWithCoordination({
    session,
    coordinationState: state(session, [stale]),
  })
  assert.equal(ignored.ok, true, ignored.message)
  assert.equal(ignored.changed, false)
  assert.equal(run(ignored.session).status, 'ready')
  assert.equal(run(ignored.session).attempt, 1)
  assert.ok(ignored.notices.some(item => item.code === 'STALE_EFFECT'))

  const fresh = createSession()
  const completed = record('completed', {
    snapshot: snapshot('completed', 'task-1', 'dispatch-task-1-1', { result: result() }),
  })
  const reviewed = reconcileTaskSessionWithCoordination({
    session: fresh,
    coordinationState: state(fresh, [completed]),
  })
  assert.equal(reviewed.ok, true, reviewed.message)
  const conflictResult = { ...result(), summary: 'Conflicting late result' }
  const conflict = record('completed', {
    snapshot: snapshot('completed', 'task-1', 'dispatch-task-1-1', { result: conflictResult }),
  })
  const preserved = reconcileTaskSessionWithCoordination({
    session: reviewed.session,
    coordinationState: state(reviewed.session, [conflict]),
  })
  assert.equal(preserved.ok, true, preserved.message)
  assert.equal(preserved.changed, false)
  assert.equal(run(preserved.session).result.summary, 'Summary for task-1')
  assert.ok(preserved.notices.some(item => item.code === 'RESULT_MISMATCH'))
})

test('independent tasks stay isolated and reconciliation does not mutate inputs', () => {
  const session = createSession([
    task('task-1', 'deepseek'),
    task('task-2', 'codex'),
  ])
  const coordinationState = state(session, [record('queued')])
  const beforeSession = structuredClone(session)
  const beforeState = structuredClone(coordinationState)
  const outcome = reconcileTaskSessionWithCoordination({ session, coordinationState })
  assert.equal(outcome.ok, true, outcome.message)
  assert.equal(run(outcome.session, 'task-1').status, 'running')
  assert.equal(run(outcome.session, 'task-2').status, 'ready')
  assert.deepEqual(session, beforeSession)
  assert.deepEqual(coordinationState, beforeState)
})
