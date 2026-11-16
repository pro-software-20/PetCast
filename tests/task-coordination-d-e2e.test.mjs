import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTs } from './load-ts.mjs'

const { createTaskCoordinationController } = await loadTs('../src/orchestration/TaskCoordinationController.ts')
const { MemoryTaskCoordinationStore } = await loadTs('../src/orchestration/TaskCoordinationStore.ts')
const { MemoryTaskAcceptanceStore } = await loadTs('../src/orchestration/TaskAcceptanceStore.ts')
const { InMemoryExecutionAdapter } = await loadTs('../src/orchestration/executionAdapterFixtures.ts')
const { MapExecutionAdapterRegistry } = await loadTs('../src/orchestration/taskCoordinator.ts')
const { requestTaskEvaluation } = await loadTs('../src/orchestration/taskEvaluationWorkflow.ts')
const { reconcileTaskEvaluation } = await loadTs('../src/orchestration/taskEvaluationReconciliation.ts')
const { createTaskSession, updateTaskSession } = await loadTs('../src/orchestration/taskSession.ts')
const { generateTaskSessionReport } = await loadTs('../src/orchestration/taskReport.ts')
const { TaskEvidenceAdapter } = await loadTs('../src/reports/taskEvidenceAdapter.ts')

const fullOutputMarker = 'PRIVATE_FULL_AI_OUTPUT_MUST_STAY_LOCAL'
const policy = { mode: 'trusted-evaluation', trustedMethods: ['rubric'], maxAttempts: 3 }
const analysisResult = {
  taskType: 'mixed',
  complexity: 'medium',
  estimatedInputTokens: { min: 10, max: 20 },
  estimatedOutputTokens: { min: 100, max: 300 },
  estimationBasis: 'heuristic-metadata',
  assumptions: ['Local acceptance fixture.'],
  optimizedPrompt: 'Complete independent tasks, then combine their results.',
  promptOptimizationSource: 'local',
  canRunInParallel: true,
  parallelPlan: ['Run independent roots first.', 'Combine their reviewed results.'],
  warnings: [],
}

const taskNode = (id, providerId, dependsOn = []) => ({
  id,
  title: id,
  description: `Complete ${id} using a local execution fixture.`,
  dependsOn,
  recommendedProviderId: providerId,
  executionMode: 'api',
  prompt: `Produce the result for ${id}.`,
  files: { inputs: [], readPaths: [], allowedWritePaths: [], forbiddenPaths: [], outputPaths: [] },
  expectedDeliverables: [`${id} result`],
  acceptanceChecks: [`${id} accepted`],
})

const makeSession = (tasks = [
  taskNode('root-analysis', 'deepseek'),
  taskNode('root-writing', 'doubao'),
  taskNode('final-summary', 'deepseek', ['root-analysis', 'root-writing']),
]) => {
  const created = createTaskSession({
    analysisInput: { prompt: 'Coordinate two roots and a dependent summary.', files: [] },
    analysisResult,
    plan: {
      schemaVersion: 1,
      id: 'plan-real-d-e2e',
      title: 'Real D adapter coordination acceptance',
      goal: 'Verify evidence review and manual completion through the B workflow.',
      assumptions: ['A execution is a zero-network fixture; D uses its production evidence rules.'],
      tasks,
      finalAcceptanceChecks: ['All tasks were reviewed by a person.'],
    },
  }, '2026-11-12T08:00:00.000Z')
  assert.equal(created.ok, true, created.message)
  return created.session
}

const makeSessionStore = initial => ({
  latest: structuredClone(initial),
  async loadLatest() { return { ok: true, session: structuredClone(this.latest) } },
  async save(session) { this.latest = structuredClone(session); return { ok: true } },
  async clear() { this.latest = null; return { ok: true } },
})

const update = (session, action) => {
  const result = updateTaskSession(session, action, new Date().toISOString())
  assert.equal(result.ok, true, result.message)
  return result.session
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))
const runUntil = async (controller, predicate) => {
  for (let index = 0; index < 30; index += 1) {
    await flush()
    await controller.runNow()
    if (predicate()) return
  }
  assert.fail('The coordinated task did not reach the expected state.')
}

const makeExecutionAdapter = (providerId, requests) => new InMemoryExecutionAdapter(async request => {
  requests.push(structuredClone(request))
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
        summary: `Reviewed handoff for ${request.taskId}.`,
        keyDecisions: [`Decision from ${request.taskId}`],
        artifacts: [],
        openQuestions: [],
      },
    },
  }
})

const makeController = (session, stores, adapters, onSessionChange) => createTaskCoordinationController({
  session,
  coordinationStore: stores.coordination,
  sessionStore: stores.session,
  adapters,
  policy: { globalConcurrency: 2, providerConcurrency: 1, pollIntervalMs: 60_000 },
  onSessionChange,
})

const evidenceFor = () => [{ type: 'user-review', reference: 'check:0', summary: 'A person checked the deliverable.' }]

test('real D adapter reviews parallel roots, then the dependent task, before a human completes the report', async () => {
  const originalFetch = globalThis.fetch
  let networkCalls = 0
  globalThis.fetch = async () => { networkCalls += 1; throw new Error('Network is forbidden in this acceptance test.') }

  let session = makeSession()
  const initialSession = structuredClone(session)
  const stores = {
    session: makeSessionStore(session),
    coordination: new MemoryTaskCoordinationStore(),
    acceptance: new MemoryTaskAcceptanceStore(),
  }
  const deepseekRequests = []
  const doubaoRequests = []
  const deepseek = makeExecutionAdapter('deepseek', deepseekRequests)
  const doubao = makeExecutionAdapter('doubao', doubaoRequests)
  const adapters = new MapExecutionAdapterRegistry([['deepseek', deepseek], ['doubao', doubao]])
  const dRequests = []
  const productionD = new TaskEvidenceAdapter()
  const dAdapter = {
    async evaluate(request, signal) {
      dRequests.push(structuredClone(request))
      return productionD.evaluate(request, signal)
    },
  }
  let controller = makeController(session, stores, adapters, value => { session = value })

  try {
    await controller.start() // Confirmation does not dispatch.
    assert.equal(deepseek.dispatchCallCount + doubao.dispatchCallCount, 0)
    await controller.start()
    assert.equal(deepseek.dispatchCallCount, 1)
    assert.equal(doubao.dispatchCallCount, 1)
    assert.deepEqual(session.runs.map(run => run.status), ['running', 'running', 'waiting'])

    controller.dispose()
    controller = makeController(session, stores, adapters, value => { session = value })
    let restoredStatus
    controller.subscribe(snapshot => { restoredStatus = snapshot.status })
    assert.equal(restoredStatus, 'paused')
    await runUntil(controller, () => session.runs[0].status === 'review' && session.runs[1].status === 'review')
    assert.equal(deepseek.dispatchCallCount, 1)
    assert.equal(doubao.dispatchCallCount, 1)
    assert.equal(session.runs[2].status, 'waiting')

    for (const taskId of ['root-analysis', 'root-writing']) {
      session = update(session, { type: 'set-review-verification', taskId, index: 0, status: 'passed' })
      const evaluated = await requestTaskEvaluation({
        session, taskId, adapter: dAdapter,
        coordinationStore: stores.coordination,
        acceptanceStore: stores.acceptance,
        policy,
        evidence: evidenceFor(),
        signal: new AbortController().signal,
      })
      assert.equal(evaluated.ok, true, evaluated.message)
      assert.equal(evaluated.record.report.verdict, 'accepted')
      assert.equal(evaluated.decision.action, 'complete')
      assert.equal(session.runs.find(run => run.taskId === taskId).status, 'review')

      // A new D instance must not be called: persisted B acceptance is authoritative.
      const reused = await requestTaskEvaluation({
        session, taskId,
        adapter: { evaluate: async () => assert.fail('Persisted evaluation was unexpectedly rerun.') },
        coordinationStore: stores.coordination,
        acceptanceStore: stores.acceptance,
        policy,
        signal: new AbortController().signal,
      })
      assert.equal(reused.ok, true, reused.message)
      assert.equal(reused.reused, true)
      session = update(session, { type: 'accept', taskId })
      controller.updateSession(session)
    }
    assert.equal(dRequests.length, 2)
    assert.equal(session.runs[2].status, 'ready')

    await controller.start()
    await controller.start()
    await runUntil(controller, () => session.runs[2].status === 'review')
    assert.equal(deepseek.dispatchCallCount, 2)
    const finalDispatch = deepseekRequests.find(request => request.taskId === 'final-summary')
    assert.deepEqual(finalDispatch.directDependencies.map(item => item.dependencyTaskId), ['root-analysis', 'root-writing'])
    assert.doesNotMatch(JSON.stringify(finalDispatch.directDependencies), new RegExp(fullOutputMarker))

    session = update(session, { type: 'set-review-verification', taskId: 'final-summary', index: 0, status: 'passed' })
    const evaluated = await requestTaskEvaluation({
      session, taskId: 'final-summary', adapter: dAdapter,
      coordinationStore: stores.coordination,
      acceptanceStore: stores.acceptance,
      policy, evidence: evidenceFor(), signal: new AbortController().signal,
    })
    assert.equal(evaluated.ok, true, evaluated.message)
    assert.equal(evaluated.record.report.verdict, 'accepted')
    assert.equal(session.runs[2].status, 'review')

    const staleReport = { ...evaluated.record.report, dispatchId: 'dispatch:obsolete:1' }
    const stale = reconcileTaskEvaluation({
      session,
      coordinationState: stores.coordination.peek(),
      acceptanceState: stores.acceptance.peek(),
      report: staleReport,
      policy,
    })
    assert.equal(stale.ok, false)
    assert.equal(stale.code, 'STATE_MISMATCH')

    session = update(session, { type: 'accept', taskId: 'final-summary' })
    session = update(session, { type: 'set-final-verification', index: 0, status: 'passed' })
    const report = generateTaskSessionReport(session)
    assert.equal(report.ok, true, report.message)
    assert.match(report.markdown, /Real D adapter coordination acceptance/)
    assert.doesNotMatch(report.markdown, new RegExp(fullOutputMarker))
    assert.equal(dRequests.length, 3)
    assert.doesNotMatch(JSON.stringify(dRequests), new RegExp(fullOutputMarker))
    assert.doesNotMatch(JSON.stringify(dRequests), /api[_-]?key|credential|quota|[A-Z]:\\|\/Users\//i)
    assert.equal(networkCalls, 0)
    assert.deepEqual(initialSession.runs.map(run => run.status), ['ready', 'ready', 'waiting'])
  } finally {
    controller.dispose()
    globalThis.fetch = originalFetch
  }
})

test('real D adapter returns revise for a failed check and unknown without matching evidence', async () => {
  for (const [name, verification, evidence, verdict, expectedAction] of [
    ['failed-check', 'failed', evidenceFor(), 'revise', 'request-changes'],
    ['missing-evidence', 'passed', [], 'unknown', 'manual-review'],
  ]) {
    let session = makeSession([taskNode(name, 'deepseek')])
    const coordination = new MemoryTaskCoordinationStore()
    const acceptance = new MemoryTaskAcceptanceStore()
    const adapter = makeExecutionAdapter('deepseek', [])
    const controller = makeController(session, { session: makeSessionStore(session), coordination },
      new MapExecutionAdapterRegistry([['deepseek', adapter]]), value => { session = value })
    try {
      await controller.start()
      await controller.start()
      await runUntil(controller, () => session.runs[0].status === 'review')
      session = update(session, { type: 'set-review-verification', taskId: name, index: 0, status: verification })
      const evaluated = await requestTaskEvaluation({
        session, taskId: name, adapter: new TaskEvidenceAdapter(),
        coordinationStore: coordination, acceptanceStore: acceptance,
        policy, evidence, signal: new AbortController().signal,
      })
      assert.equal(evaluated.ok, true, evaluated.message)
      assert.equal(evaluated.record.report.verdict, verdict)
      assert.equal(evaluated.decision.action, expectedAction)
      assert.equal(session.runs[0].status, 'review')
      if (verdict === 'revise') {
        session = update(session, { type: 'request-changes', taskId: name, message: 'Please revise the failed check.' })
        assert.equal(session.runs[0].status, 'running')
        const late = reconcileTaskEvaluation({
          session,
          coordinationState: coordination.peek(),
          acceptanceState: acceptance.peek(),
          report: evaluated.record.report,
          policy,
        })
        assert.equal(late.ok, false)
        assert.equal(late.code, 'STATE_MISMATCH')
      } else {
        // An unknown D verdict leaves the user in charge. The person may
        // explicitly accept a task whose own verification was marked passed.
        session = update(session, { type: 'accept', taskId: name })
        assert.equal(session.runs[0].status, 'done')
      }
      assert.equal(adapter.dispatchCallCount, 1)
    } finally {
      controller.dispose()
    }
  }
})
