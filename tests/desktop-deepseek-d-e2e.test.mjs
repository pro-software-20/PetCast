import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTs } from './load-ts.mjs'

const { createDesktopCoordinationAdapterRegistry } = await loadTs('../src/orchestration/desktopExecutionAdapters.ts')
const { createTaskCoordinationController } = await loadTs('../src/orchestration/TaskCoordinationController.ts')
const { MemoryTaskCoordinationStore } = await loadTs('../src/orchestration/TaskCoordinationStore.ts')
const { MemoryTaskAcceptanceStore } = await loadTs('../src/orchestration/TaskAcceptanceStore.ts')
const { requestTaskEvaluation } = await loadTs('../src/orchestration/taskEvaluationWorkflow.ts')
const { createTaskSession, updateTaskSession } = await loadTs('../src/orchestration/taskSession.ts')
const { TaskEvidenceAdapter } = await loadTs('../src/reports/taskEvidenceAdapter.ts')

const CREATED = '2026-11-17T08:00:00.000Z'
const COMPLETED = '2026-11-17T08:00:04.000Z'
const fullOutputMarker = 'FULL_DEEPSEEK_OUTPUT_MUST_NOT_REACH_D'

const createSession = () => {
  const created = createTaskSession({
    analysisInput: { prompt: 'Review a short, safe analysis task.', files: [] },
    analysisResult: {
      taskType: 'analysis',
      complexity: 'low',
      estimatedInputTokens: { min: 10, max: 20 },
      estimatedOutputTokens: { min: 20, max: 80 },
      estimationBasis: 'heuristic-metadata',
      assumptions: ['The desktop bridge is deterministic.'],
      optimizedPrompt: 'Review a short, safe analysis task.',
      promptOptimizationSource: 'local',
      canRunInParallel: false,
      parallelPlan: ['Run the one task.'],
      warnings: [],
    },
    plan: {
      schemaVersion: 1,
      id: 'desktop-deepseek-d-plan',
      title: 'Desktop DeepSeek and D acceptance',
      goal: 'Verify the user-confirmed coordination and evaluation path.',
      assumptions: ['No provider or network is used by this fixture.'],
      tasks: [{
        id: 'deepseek-review-task',
        title: 'Review a safe analysis',
        description: 'Produce a safe and reviewable analysis summary.',
        dependsOn: [],
        recommendedProviderId: 'deepseek',
        executionMode: 'api',
        prompt: 'Return a concise analysis summary.',
        files: { inputs: [], readPaths: [], allowedWritePaths: [], forbiddenPaths: [], outputPaths: [] },
        expectedDeliverables: ['Analysis summary'],
        acceptanceChecks: ['Summary is reviewable'],
      }],
      finalAcceptanceChecks: ['The user reviewed the result.'],
    },
  }, CREATED)
  assert.equal(created.ok, true, created.message)
  return created.session
}

const createSessionStore = initial => ({
  latest: structuredClone(initial),
  async loadLatest() { return { ok: true, session: structuredClone(this.latest) } },
  async save(session) { this.latest = structuredClone(session); return { ok: true } },
  async clear() { this.latest = null; return { ok: true } },
})

const update = (session, action) => {
  const outcome = updateTaskSession(session, action, COMPLETED)
  assert.equal(outcome.ok, true, outcome.message)
  return outcome.session
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))
const runUntil = async (controller, predicate) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await flush()
    await controller.runNow()
    if (predicate()) return
  }
  assert.fail('The desktop DeepSeek fixture did not enter review.')
}

const createDesktopBridge = () => {
  const calls = { dispatch: 0, inspect: 0, cancel: 0 }
  let receipt
  return {
    calls,
    bridge: {
      async dispatchDeepSeekExecution(request) {
        calls.dispatch += 1
        if (receipt) return { ok: true, value: structuredClone(receipt) }
        receipt = {
          dispatchId: request.dispatchId,
          adapterExecutionId: 'desktop-deepseek-fixture-1',
          taskId: request.taskId,
          state: 'queued',
          acceptedAt: CREATED,
        }
        return { ok: true, value: structuredClone(receipt) }
      },
      async inspectDeepSeekExecution(reference) {
        calls.inspect += 1
        assert.deepEqual(reference, {
          dispatchId: receipt?.dispatchId,
          adapterExecutionId: receipt?.adapterExecutionId,
          taskId: receipt?.taskId,
        })
        return {
          ok: true,
          value: {
            ...reference,
            state: 'completed',
            observedAt: COMPLETED,
            result: {
              summary: 'Safe DeepSeek analysis summary.',
              outputText: `${fullOutputMarker}: source output stays in the local task result.`,
              verification: [{ label: 'Summary is reviewable', status: 'not-run' }],
              usage: { inputTokens: 12, outputTokens: 8 },
            },
          },
        }
      },
      async cancelDeepSeekExecution(reference) {
        calls.cancel += 1
        return {
          ok: true,
          value: {
            ...reference,
            state: 'cancelled',
            observedAt: COMPLETED,
            error: { code: 'CANCELLED', retryable: false, message: 'Fixture cancellation.' },
          },
        }
      },
    },
  }
}

test('desktop DeepSeek bridge completes once, restores paused evidence, and sends only safe material to D', async () => {
  const originalFetch = globalThis.fetch
  let networkCalls = 0
  globalThis.fetch = async () => { networkCalls += 1; throw new Error('Network is forbidden in this acceptance test.') }

  let session = createSession()
  const sessionStore = createSessionStore(session)
  const coordinationStore = new MemoryTaskCoordinationStore()
  const acceptanceStore = new MemoryTaskAcceptanceStore()
  const desktop = createDesktopBridge()
  const adapters = createDesktopCoordinationAdapterRegistry(desktop.bridge)
  const dRequests = []
  const d = new TaskEvidenceAdapter()
  const evaluationAdapter = {
    async evaluate(request, signal) {
      dRequests.push(structuredClone(request))
      return d.evaluate(request, signal)
    },
  }
  const makeController = () => createTaskCoordinationController({
    session,
    coordinationStore,
    sessionStore,
    adapters,
    policy: { globalConcurrency: 2, providerConcurrency: 1, pollIntervalMs: 60_000 },
    onSessionChange: value => { session = value },
  })
  let controller = makeController()

  try {
    await controller.start()
    assert.equal(desktop.calls.dispatch, 0, 'The confirmation screen must not call DeepSeek.')
    await controller.start()
    assert.equal(desktop.calls.dispatch, 1)
    await runUntil(controller, () => session.runs[0].status === 'review')
    assert.equal(session.runs[0].status, 'review')
    assert.equal(desktop.calls.dispatch, 1)

    const inspectCallsBeforeRestart = desktop.calls.inspect
    controller.dispose()
    controller = makeController()
    let restored
    const unsubscribe = controller.subscribe(snapshot => { restored = snapshot })
    await controller.hydrate()
    unsubscribe()
    assert.equal(restored.status, 'paused')
    assert.equal(restored.records.length, 1)
    assert.equal(restored.records[0].phase, 'completed')
    assert.equal(desktop.calls.dispatch, 1)
    assert.equal(desktop.calls.inspect, inspectCallsBeforeRestart)

    session = update(session, {
      type: 'set-review-verification', taskId: 'deepseek-review-task', index: 0, status: 'passed',
    })
    controller.updateSession(session)
    const first = await requestTaskEvaluation({
      session,
      taskId: 'deepseek-review-task',
      adapter: evaluationAdapter,
      coordinationStore,
      acceptanceStore,
      policy: { mode: 'trusted-evaluation', trustedMethods: ['rubric'], maxAttempts: 3 },
      evidence: [{ type: 'user-review', reference: 'check:0', summary: 'A user reviewed the summary.' }],
      signal: new AbortController().signal,
    })
    assert.equal(first.ok, true, first.message)
    assert.equal(first.record.report.verdict, 'accepted')
    assert.equal(first.decision.action, 'complete')
    assert.equal(session.runs[0].status, 'review', 'D only advises; the user still decides.')

    const reused = await requestTaskEvaluation({
      session,
      taskId: 'deepseek-review-task',
      adapter: { evaluate: async () => assert.fail('A saved D evaluation must be reused.') },
      coordinationStore,
      acceptanceStore,
      policy: { mode: 'trusted-evaluation', trustedMethods: ['rubric'], maxAttempts: 3 },
      signal: new AbortController().signal,
    })
    assert.equal(reused.ok, true, reused.message)
    assert.equal(reused.reused, true)
    assert.equal(dRequests.length, 1)
    assert.doesNotMatch(JSON.stringify(dRequests), new RegExp(fullOutputMarker))
    assert.doesNotMatch(JSON.stringify(dRequests), /api[_-]?key|credential|quota|[A-Z]:\\|\/Users\//i)
    assert.equal(networkCalls, 0)
  } finally {
    controller.dispose()
    globalThis.fetch = originalFetch
  }
})
