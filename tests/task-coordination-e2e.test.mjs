import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTs } from './load-ts.mjs'

const { createTaskCoordinationController } = await loadTs('../src/orchestration/TaskCoordinationController.ts')
const { MemoryTaskCoordinationStore } = await loadTs('../src/orchestration/TaskCoordinationStore.ts')
const { MemoryTaskAcceptanceStore } = await loadTs('../src/orchestration/TaskAcceptanceStore.ts')
const { InMemoryExecutionAdapter } = await loadTs('../src/orchestration/executionAdapterFixtures.ts')
const { createInMemoryTaskEvaluationAdapter } = await loadTs('../src/orchestration/taskEvaluationFixtures.ts')
const { MapExecutionAdapterRegistry } = await loadTs('../src/orchestration/taskCoordinator.ts')
const { requestTaskEvaluation } = await loadTs('../src/orchestration/taskEvaluationWorkflow.ts')
const { createTaskSession, updateTaskSession } = await loadTs('../src/orchestration/taskSession.ts')
const { generateTaskSessionReport } = await loadTs('../src/orchestration/taskReport.ts')

const manualPolicy = { mode: 'manual', trustedMethods: ['rubric'], maxAttempts: 3 }
const trustedPolicy = { mode: 'trusted-evaluation', trustedMethods: ['rubric'], maxAttempts: 3 }

const analysisResult = {
  taskType: 'mixed',
  complexity: 'high',
  estimatedInputTokens: { min: 20, max: 40 },
  estimatedOutputTokens: { min: 200, max: 400 },
  estimationBasis: 'heuristic-metadata',
  assumptions: ['Zero-network acceptance fixture.'],
  optimizedPrompt: 'Coordinate independent work and then produce a summary.',
  promptOptimizationSource: 'local',
  canRunInParallel: true,
  parallelPlan: ['Run the two roots in parallel.', 'Summarize after both roots complete.'],
  warnings: [],
}

const task = (id, providerId, dependsOn = []) => ({
  id,
  title: id,
  description: `Complete ${id} with a zero-network fixture.`,
  dependsOn,
  recommendedProviderId: providerId,
  executionMode: 'api',
  prompt: `Produce the structured result for ${id}.`,
  files: { inputs: [], readPaths: [], allowedWritePaths: [], forbiddenPaths: [], outputPaths: [] },
  expectedDeliverables: [`${id} result`],
  acceptanceChecks: [`${id} accepted`],
})

const createSession = (tasks = [
  task('root-analysis', 'deepseek'),
  task('root-writing', 'doubao'),
  task('final-summary', 'deepseek', ['root-analysis', 'root-writing']),
]) => {
  const created = createTaskSession({
    analysisInput: { prompt: 'Coordinate the fixture tasks.', files: [] },
    analysisResult,
    plan: {
      schemaVersion: 1,
      id: 'plan-zero-network-e2e',
      title: 'Zero-network coordination acceptance',
      goal: 'Verify the complete B coordination lifecycle without external calls.',
      assumptions: ['All A and D implementations are in-memory fixtures.'],
      tasks,
      finalAcceptanceChecks: ['All coordinated tasks were reviewed by a user.'],
    },
  }, '2026-11-09T08:00:00.000Z')
  assert.equal(created.ok, true, created.message)
  return created.session
}

const createSessionStore = (initial, { failNextSave = false } = {}) => ({
  latest: structuredClone(initial),
  writes: [],
  failNextSave,
  async loadLatest() { return { ok: true, session: structuredClone(this.latest) } },
  async save(session) {
    if (this.failNextSave) {
      this.failNextSave = false
      return { ok: false, code: 'STORAGE_UNAVAILABLE', message: 'Fixture storage unavailable.' }
    }
    this.latest = structuredClone(session)
    this.writes.push(structuredClone(session))
    return { ok: true }
  },
  async clear() { this.latest = null; return { ok: true } },
})

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

const runUntil = async (controller, predicate, attempts = 30) => {
  for (let index = 0; index < attempts; index += 1) {
    await flush()
    await controller.runNow()
    if (predicate()) return
  }
  assert.fail('Coordination fixture did not reach the expected state.')
}

const update = (session, action) => {
  const outcome = updateTaskSession(session, action, new Date().toISOString())
  assert.equal(outcome.ok, true, outcome.message)
  return outcome.session
}

const passAndAccept = (session, taskId) => {
  let next = update(session, { type: 'set-review-verification', taskId, index: 0, status: 'passed' })
  next = update(next, { type: 'accept', taskId })
  return next
}

const createExecutionAdapter = (providerId, captured, fullOutputMarker) => new InMemoryExecutionAdapter(
  async request => {
    captured.push(structuredClone(request))
    return {
      ok: true,
      value: {
        taskId: request.taskId,
        providerId,
        summary: `Safe summary for ${request.taskId}.`,
        outputText: `${fullOutputMarker}:${request.taskId}`,
        changedFiles: [],
        verification: request.task.acceptanceChecks.map(label => ({ label, status: 'not-run' })),
        handoff: {
          summary: `Handoff summary for ${request.taskId}.`,
          keyDecisions: [`Decision from ${request.taskId}`],
          artifacts: [],
          openQuestions: [],
        },
      },
    }
  },
)

test('zero-network chain dispatches parallel roots, evaluates advisably, unlocks summary, and reports', async () => {
  const originalFetch = globalThis.fetch
  let networkCalls = 0
  globalThis.fetch = async () => { networkCalls += 1; throw new Error('Network access is forbidden in P3.4A.') }

  let session = createSession()
  const originalSession = structuredClone(session)
  const sessionStore = createSessionStore(session)
  const coordinationStore = new MemoryTaskCoordinationStore()
  const acceptanceStore = new MemoryTaskAcceptanceStore()
  const deepseekRequests = []
  const doubaoRequests = []
  const fullOutputMarker = 'FULL_OUTPUT_MUST_NOT_CROSS_DEPENDENCY_BOUNDARY'
  const deepseek = createExecutionAdapter('deepseek', deepseekRequests, fullOutputMarker)
  const doubao = createExecutionAdapter('doubao', doubaoRequests, fullOutputMarker)
  const adapters = new MapExecutionAdapterRegistry([
    ['deepseek', deepseek],
    ['doubao', doubao],
  ])
  const controller = createTaskCoordinationController({
    session,
    coordinationStore,
    sessionStore,
    adapters,
    policy: { globalConcurrency: 2, providerConcurrency: 1, pollIntervalMs: 60_000 },
    onSessionChange: value => { session = value },
  })

  try {
    await controller.start()
    await controller.start()
    assert.equal(deepseek.dispatchCallCount, 1)
    assert.equal(doubao.dispatchCallCount, 1)
    assert.deepEqual(session.runs.map(run => run.status), ['running', 'running', 'waiting'])

    await runUntil(controller, () => session.runs[0].status === 'review' && session.runs[1].status === 'review')
    assert.equal(session.runs[2].status, 'waiting')

    const evaluationDelegate = createInMemoryTaskEvaluationAdapter('accepted')
    let evaluationCalls = 0
    const evaluationAdapter = {
      async evaluate(request, signal) {
        evaluationCalls += 1
        return evaluationDelegate.evaluate(request, signal)
      },
    }
    for (const taskId of ['root-analysis', 'root-writing']) {
      const evaluated = await requestTaskEvaluation({
        session,
        taskId,
        adapter: evaluationAdapter,
        coordinationStore,
        acceptanceStore,
        policy: manualPolicy,
        signal: new AbortController().signal,
      })
      assert.equal(evaluated.ok, true, evaluated.message)
      assert.equal(evaluated.decision.action, 'manual-review')
      assert.equal(session.runs.find(run => run.taskId === taskId).status, 'review')

      const reused = await requestTaskEvaluation({
        session,
        taskId,
        adapter: evaluationAdapter,
        coordinationStore,
        acceptanceStore,
        policy: manualPolicy,
        signal: new AbortController().signal,
      })
      assert.equal(reused.ok, true, reused.message)
      assert.equal(reused.reused, true)
      session = passAndAccept(session, taskId)
      controller.updateSession(session)
    }
    assert.equal(evaluationCalls, 2)

    await runUntil(controller, () => deepseek.dispatchCallCount === 2)
    const summaryDispatch = deepseekRequests.find(request => request.taskId === 'final-summary')
    assert.ok(summaryDispatch)
    assert.deepEqual(
      summaryDispatch.directDependencies.map(item => item.dependencyTaskId),
      ['root-analysis', 'root-writing'],
    )
    const dependencyPayload = JSON.stringify(summaryDispatch.directDependencies)
    assert.doesNotMatch(dependencyPayload, new RegExp(fullOutputMarker))
    assert.doesNotMatch(dependencyPayload, /api[_-]?key|credential|quota|[A-Z]:\\\\|\/Users\//i)

    await runUntil(controller, () => session.runs[2].status === 'review')
    const summaryEvaluation = await requestTaskEvaluation({
      session,
      taskId: 'final-summary',
      adapter: evaluationAdapter,
      coordinationStore,
      acceptanceStore,
      policy: trustedPolicy,
      signal: new AbortController().signal,
    })
    assert.equal(summaryEvaluation.ok, true, summaryEvaluation.message)
    assert.equal(summaryEvaluation.decision.action, 'complete')
    assert.equal(session.runs[2].status, 'review')

    session = passAndAccept(session, 'final-summary')
    session = update(session, { type: 'set-final-verification', index: 0, status: 'passed' })
    const report = generateTaskSessionReport(session)
    assert.equal(report.ok, true, report.message)
    assert.match(report.markdown, /Zero-network coordination acceptance/)
    assert.equal(networkCalls, 0)
    assert.deepEqual(originalSession.runs.map(run => run.status), ['ready', 'ready', 'waiting'])
  } finally {
    controller.dispose()
    globalThis.fetch = originalFetch
  }
})

test('revise and unknown evaluations remain advisory until the user acts', async () => {
  for (const [scenario, expectedAction] of [
    ['revise', 'request-changes'],
    ['unknown', 'manual-review'],
  ]) {
    let session = createSession([task(`evaluation-${scenario}`, 'deepseek')])
    const adapter = createExecutionAdapter('deepseek', [], 'PRIVATE_OUTPUT')
    const coordinationStore = new MemoryTaskCoordinationStore()
    const controller = createTaskCoordinationController({
      session,
      coordinationStore,
      sessionStore: createSessionStore(session),
      adapters: new MapExecutionAdapterRegistry([['deepseek', adapter]]),
      policy: { pollIntervalMs: 60_000 },
      onSessionChange: value => { session = value },
    })

    try {
      await controller.start()
      await controller.start()
      await runUntil(controller, () => session.runs[0].status === 'review')
      const evaluated = await requestTaskEvaluation({
        session,
        taskId: session.plan.tasks[0].id,
        adapter: createInMemoryTaskEvaluationAdapter(scenario),
        coordinationStore,
        acceptanceStore: new MemoryTaskAcceptanceStore(),
        policy: trustedPolicy,
        signal: new AbortController().signal,
      })
      assert.equal(evaluated.ok, true, evaluated.message)
      assert.equal(evaluated.decision.action, expectedAction)
      assert.equal(session.runs[0].status, 'review')
      assert.notEqual(session.runs[0].status, 'done')
    } finally {
      controller.dispose()
    }
  }
})

test('needs-input, failed, cancelled, and unknown executions map to safe user-visible states', async () => {
  for (const [name, outcome, expectedStatus] of [
    ['needs-input', { ok: false, error: { code: 'NEEDS_INPUT', message: 'More input is required.', retryable: false } }, 'needs-input'],
    ['failed', { ok: false, error: { code: 'FAILED', message: 'Fixture execution failed.', retryable: false } }, 'failed'],
  ]) {
    let session = createSession([task(`execution-${name}`, 'deepseek')])
    const adapter = new InMemoryExecutionAdapter(async () => structuredClone(outcome))
    const controller = createTaskCoordinationController({
      session,
      coordinationStore: new MemoryTaskCoordinationStore(),
      sessionStore: createSessionStore(session),
      adapters: new MapExecutionAdapterRegistry([['deepseek', adapter]]),
      policy: { pollIntervalMs: 60_000 },
      onSessionChange: value => { session = value },
    })
    try {
      await controller.start()
      await controller.start()
      await runUntil(controller, () => session.runs[0].status === expectedStatus)
      assert.equal(adapter.dispatchCallCount, 1)
    } finally {
      controller.dispose()
    }
  }

  let cancelledSession = createSession([task('execution-cancelled', 'deepseek')])
  const waitingAdapter = new InMemoryExecutionAdapter(async (_request, signal) => new Promise(resolve => {
    signal.addEventListener('abort', () => resolve({
      ok: false,
      error: { code: 'CANCELLED', message: 'Fixture execution cancelled.', retryable: false },
    }), { once: true })
  }))
  const cancelledController = createTaskCoordinationController({
    session: cancelledSession,
    coordinationStore: new MemoryTaskCoordinationStore(),
    sessionStore: createSessionStore(cancelledSession),
    adapters: new MapExecutionAdapterRegistry([['deepseek', waitingAdapter]]),
    policy: { pollIntervalMs: 60_000 },
    onSessionChange: value => { cancelledSession = value },
  })
  try {
    await cancelledController.start()
    await cancelledController.start()
    await cancelledController.cancelTask('execution-cancelled')
    assert.equal(cancelledSession.runs[0].status, 'cancelled')
    assert.equal(waitingAdapter.dispatchCallCount, 1)
  } finally {
    cancelledController.dispose()
  }

  let unknownSession = createSession([task('execution-unknown', 'deepseek')])
  let unknownDispatchCalls = 0
  const unknownAdapter = {
    async dispatch(request) {
      unknownDispatchCalls += 1
      return {
        ok: true,
        value: {
          dispatchId: request.dispatchId,
          adapterExecutionId: `missing:${request.dispatchId}`,
          taskId: request.taskId,
          state: 'queued',
          acceptedAt: new Date().toISOString(),
        },
      }
    },
    async inspect() {
      return {
        ok: false,
        error: { code: 'EXECUTION_NOT_FOUND', message: 'Execution reference is unknown.', retryable: false },
      }
    },
    async cancel() {
      return {
        ok: false,
        error: { code: 'EXECUTION_NOT_FOUND', message: 'Execution reference is unknown.', retryable: false },
      }
    },
  }
  const unknownController = createTaskCoordinationController({
    session: unknownSession,
    coordinationStore: new MemoryTaskCoordinationStore(),
    sessionStore: createSessionStore(unknownSession),
    adapters: new MapExecutionAdapterRegistry([['deepseek', unknownAdapter]]),
    policy: { pollIntervalMs: 60_000 },
    onSessionChange: value => { unknownSession = value },
  })
  try {
    await unknownController.start()
    await unknownController.start()
    await runUntil(unknownController, () => unknownSession.runs[0].status === 'needs-input')
    assert.equal(unknownDispatchCalls, 1)
  } finally {
    unknownController.dispose()
  }
})

test('single-provider concurrency is one and a rebuilt controller inspects without redispatch', async () => {
  let session = createSession([
    task('same-provider-a', 'deepseek'),
    task('same-provider-b', 'deepseek'),
  ])
  const captured = []
  const adapter = createExecutionAdapter('deepseek', captured, 'PRIVATE_OUTPUT')
  const adapters = new MapExecutionAdapterRegistry([['deepseek', adapter]])
  const coordinationStore = new MemoryTaskCoordinationStore()
  const sessionStore = createSessionStore(session)
  const first = createTaskCoordinationController({
    session,
    coordinationStore,
    sessionStore,
    adapters,
    policy: { globalConcurrency: 2, providerConcurrency: 1, pollIntervalMs: 60_000 },
    onSessionChange: value => { session = value },
  })
  await first.start()
  await first.start()
  assert.equal(adapter.dispatchCallCount, 1)
  first.dispose()

  const rebuilt = createTaskCoordinationController({
    session,
    coordinationStore,
    sessionStore,
    adapters,
    policy: { globalConcurrency: 2, providerConcurrency: 1, pollIntervalMs: 60_000 },
    onSessionChange: value => { session = value },
  })
  try {
    let latest
    rebuilt.subscribe(value => { latest = value })
    assert.equal(latest.status, 'paused')
    await rebuilt.runNow()
    assert.equal(adapter.dispatchCallCount, 1)
    await runUntil(rebuilt, () => session.runs[0].status === 'review')
    assert.equal(adapter.dispatchCallCount, 1)
  } finally {
    rebuilt.dispose()
  }
})

test('a persisted coordination result recovers after one session-store failure without redispatch', async () => {
  let session = createSession([task('recoverable-task', 'deepseek')])
  const captured = []
  const adapter = createExecutionAdapter('deepseek', captured, 'PRIVATE_OUTPUT')
  const adapters = new MapExecutionAdapterRegistry([['deepseek', adapter]])
  const coordinationStore = new MemoryTaskCoordinationStore()
  const failingStore = createSessionStore(session, { failNextSave: true })
  const first = createTaskCoordinationController({
    session,
    coordinationStore,
    sessionStore: failingStore,
    adapters,
    policy: { pollIntervalMs: 60_000 },
    onSessionChange: value => { session = value },
  })
  await first.start()
  await first.start()
  first.dispose()
  assert.equal(adapter.dispatchCallCount, 1)
  assert.ok(coordinationStore.peek()?.records.length)

  const healthyStore = createSessionStore(session)
  const recovered = createTaskCoordinationController({
    session,
    coordinationStore,
    sessionStore: healthyStore,
    adapters,
    onSessionChange: value => { session = value },
  })
  try {
    await runUntil(recovered, () => session.runs[0].status === 'review')
    assert.equal(adapter.dispatchCallCount, 1)
    assert.equal(session.runs[0].attempt, 1)
  } finally {
    recovered.dispose()
  }
})
