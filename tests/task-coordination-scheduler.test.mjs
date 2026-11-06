import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTs } from './load-ts.mjs'

const {
  createStableDispatchId,
  MapExecutionAdapterRegistry,
  runCoordinationCycle,
  cancelCoordinatedTask,
} = await loadTs('../src/orchestration/taskCoordinator.ts')
const {
  LocalTaskCoordinationStore,
  MemoryTaskCoordinationStore,
  TASK_COORDINATION_STORAGE_KEY,
} = await loadTs('../src/orchestration/TaskCoordinationStore.ts')
const { validateTaskCoordinationState, MAX_TASK_COORDINATION_BYTES } = await loadTs(
  '../src/orchestration/taskCoordinationStateValidation.ts',
)
const { createTaskSession, updateTaskSession } = await loadTs('../src/orchestration/taskSession.ts')

const NOW = '2026-11-05T08:00:00.000Z'
const NEXT = '2026-11-05T08:00:02.000Z'

const task = (id, providerId, executionMode = 'api', dependsOn = []) => ({
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

const createSession = (tasks) => {
  const created = createTaskSession({
    analysisInput: { prompt: 'Complete the tasks.', files: [] },
    analysisResult,
    plan: {
      schemaVersion: 1,
      id: 'plan-scheduler',
      title: 'Scheduler plan',
      goal: 'Verify deterministic coordination.',
      assumptions: ['Adapters are fixtures.'],
      tasks,
      finalAcceptanceChecks: ['All tasks completed.'],
    },
  }, NOW)
  assert.equal(created.ok, true, created.message)
  return created.session
}

const receipt = request => ({
  dispatchId: request.dispatchId,
  adapterExecutionId: `adapter-${request.dispatchId}`,
  taskId: request.taskId,
  state: 'queued',
  acceptedAt: NOW,
})

const createAdapter = (options = {}) => {
  const calls = { dispatch: [], inspect: [], cancel: [] }
  const adapter = {
    async dispatch(request) {
      calls.dispatch.push(structuredClone(request))
      if (options.onDispatch) return options.onDispatch(request)
      return { ok: true, value: receipt(request) }
    },
    async inspect(reference) {
      calls.inspect.push(structuredClone(reference))
      if (options.onInspect) return options.onInspect(reference)
      return {
        ok: true,
        value: { ...reference, state: 'running', observedAt: NEXT },
      }
    },
    async cancel(reference) {
      calls.cancel.push(structuredClone(reference))
      return {
        ok: true,
        value: {
          ...reference,
          state: 'cancelled',
          observedAt: NEXT,
          error: { code: 'CANCELLED', retryable: false, message: 'Cancelled.' },
        },
      }
    },
  }
  return { adapter, calls }
}

const registry = entries => new MapExecutionAdapterRegistry(entries)
const fixedNow = value => () => new Date(value)

test('creates stable dispatch ids from the full attempt identity', () => {
  const first = createStableDispatchId('session-1', 'plan-1', 'task-1', 1, 'codex')
  assert.equal(first, createStableDispatchId('session-1', 'plan-1', 'task-1', 1, 'codex'))
  assert.notEqual(first, createStableDispatchId('session-1', 'plan-1', 'task-1', 2, 'codex'))
  assert.notEqual(first, createStableDispatchId('session-1', 'plan-1', 'task-1', 1, 'deepseek'))
  assert.match(first, /^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$/)
})

test('dispatches independent roots with global and per-provider limits', async () => {
  const session = createSession([
    task('task-1', 'codex'),
    task('task-2', 'codex'),
    task('task-3', 'deepseek'),
  ])
  const codex = createAdapter()
  const deepseek = createAdapter()
  const store = new MemoryTaskCoordinationStore()
  const outcome = await runCoordinationCycle({
    session,
    store,
    adapters: registry([['codex', codex.adapter], ['deepseek', deepseek.adapter]]),
    now: fixedNow(NOW),
  })
  assert.equal(outcome.ok, true, outcome.error?.message)
  assert.deepEqual(codex.calls.dispatch.map(item => item.taskId), ['task-1'])
  assert.deepEqual(deepseek.calls.dispatch.map(item => item.taskId), ['task-3'])
  assert.equal(outcome.value.state.records.length, 2)
  assert.equal(outcome.value.effects.filter(item => item.type === 'dispatch-accepted').length, 2)
})

test('does not auto-dispatch manual or dependency-blocked tasks', async () => {
  const session = createSession([
    task('task-1', 'codex', 'manual'),
    task('task-2', 'deepseek', 'api', ['task-1']),
  ])
  const codex = createAdapter()
  const deepseek = createAdapter()
  const outcome = await runCoordinationCycle({
    session,
    store: new MemoryTaskCoordinationStore(),
    adapters: registry([['codex', codex.adapter], ['deepseek', deepseek.adapter]]),
    now: fixedNow(NOW),
  })
  assert.equal(outcome.ok, true)
  assert.equal(codex.calls.dispatch.length + deepseek.calls.dispatch.length, 0)
})

test('persists dispatching intent before crossing the adapter boundary', async () => {
  const session = createSession([task('task-1', 'codex')])
  const store = new MemoryTaskCoordinationStore()
  let intentWasSaved = false
  const adapter = createAdapter({
    onDispatch(request) {
      const saved = store.peek()
      intentWasSaved = saved?.records.some(item => (
        item.dispatchId === request.dispatchId && item.phase === 'dispatching' && !item.reference
      )) ?? false
      return { ok: true, value: receipt(request) }
    },
  })
  const outcome = await runCoordinationCycle({
    session,
    store,
    adapters: registry([['codex', adapter.adapter]]),
    now: fixedNow(NOW),
  })
  assert.equal(outcome.ok, true)
  assert.equal(intentWasSaved, true)
})

test('recovery inspects existing references and never redispatches them', async () => {
  const session = createSession([task('task-1', 'codex')])
  const dispatchId = createStableDispatchId(session.id, session.plan.id, 'task-1', 1, 'codex')
  const store = new MemoryTaskCoordinationStore({
    schemaVersion: 1,
    sessionId: session.id,
    planId: session.plan.id,
    updatedAt: NOW,
    records: [{
      taskId: 'task-1',
      providerId: 'codex',
      attempt: 1,
      dispatchId,
      phase: 'queued',
      reference: { dispatchId, adapterExecutionId: `adapter-${dispatchId}`, taskId: 'task-1' },
      createdAt: NOW,
      updatedAt: NOW,
    }],
  })
  const adapter = createAdapter()
  const outcome = await runCoordinationCycle({
    session,
    store,
    adapters: registry([['codex', adapter.adapter]]),
    now: fixedNow(NEXT),
  })
  assert.equal(outcome.ok, true)
  assert.equal(adapter.calls.inspect.length, 1)
  assert.equal(adapter.calls.dispatch.length, 0)
  assert.equal(outcome.value.state.records[0].phase, 'running')
  assert.ok(outcome.value.effects.some(item => item.type === 'execution-running'))
})

test('a persisted intent without a receipt becomes unknown without replay', async () => {
  const session = createSession([task('task-1', 'codex')])
  const dispatchId = createStableDispatchId(session.id, session.plan.id, 'task-1', 1, 'codex')
  const store = new MemoryTaskCoordinationStore({
    schemaVersion: 1,
    sessionId: session.id,
    planId: session.plan.id,
    updatedAt: NOW,
    records: [{
      taskId: 'task-1', providerId: 'codex', attempt: 1, dispatchId,
      phase: 'dispatching', createdAt: NOW, updatedAt: NOW,
    }],
  })
  const adapter = createAdapter()
  const outcome = await runCoordinationCycle({
    session,
    store,
    adapters: registry([['codex', adapter.adapter]]),
    now: fixedNow(NEXT),
  })
  assert.equal(outcome.ok, true)
  assert.equal(adapter.calls.dispatch.length, 0)
  assert.equal(outcome.value.state.records[0].phase, 'unknown')
  assert.ok(outcome.value.effects.some(item => item.type === 'execution-unknown'))
})

test('passes only direct dependency handoff data and excludes complete output', async () => {
  let session = createSession([
    task('task-1', 'deepseek', 'manual'),
    task('task-2', 'codex', 'api', ['task-1']),
  ])
  const apply = (action, at = NEXT) => {
    const outcome = updateTaskSession(session, action, at)
    assert.equal(outcome.ok, true, outcome.message)
    session = outcome.session
  }
  apply({ type: 'start', taskId: 'task-1' })
  apply({
    type: 'update-draft',
    taskId: 'task-1',
    draft: {
      outputText: 'PRIVATE COMPLETE OUTPUT',
      changedFiles: ['docs/decision.md'],
      verification: [{ label: 'task-1 accepted', status: 'passed' }],
      reviewNote: '',
      handoff: {
        summary: 'Safe summary.',
        keyDecisions: ['Use the stable contract.'],
        artifacts: [{ path: 'docs/decision.md', description: 'Decision record.' }],
        openQuestions: ['Confirm rollout.'],
      },
    },
  })
  apply({ type: 'submit-result', taskId: 'task-1' })
  apply({ type: 'accept', taskId: 'task-1' })
  apply({
    type: 'confirm-handoff-artifact',
    taskId: 'task-2',
    dependencyTaskId: 'task-1',
    path: 'docs/decision.md',
    provided: true,
  })

  const adapter = createAdapter()
  const outcome = await runCoordinationCycle({
    session,
    store: new MemoryTaskCoordinationStore(),
    adapters: registry([['codex', adapter.adapter]]),
    now: fixedNow(NEXT),
  })
  assert.equal(outcome.ok, true)
  assert.equal(adapter.calls.dispatch.length, 1)
  const request = adapter.calls.dispatch[0]
  assert.deepEqual(request.directDependencies.map(item => item.dependencyTaskId), ['task-1'])
  assert.equal(request.directDependencies[0].summary, 'Safe summary.')
  assert.equal(JSON.stringify(request).includes('PRIVATE COMPLETE OUTPUT'), false)
})

test('blocks API dispatch until dependency artifacts are confirmed for the selected provider', async () => {
  let session = createSession([
    task('task-1', 'deepseek', 'manual'),
    task('task-2', 'codex', 'api', ['task-1']),
  ])
  const apply = (action) => {
    const outcome = updateTaskSession(session, action, NEXT)
    assert.equal(outcome.ok, true, outcome.message)
    session = outcome.session
  }
  apply({ type: 'start', taskId: 'task-1' })
  apply({
    type: 'update-draft', taskId: 'task-1', draft: {
      outputText: 'result', changedFiles: ['docs/decision.md'], reviewNote: '',
      verification: [{ label: 'task-1 accepted', status: 'passed' }],
      handoff: {
        summary: 'Decision ready.', keyDecisions: [], openQuestions: [],
        artifacts: [{ path: 'docs/decision.md', description: 'Decision record.' }],
      },
    },
  })
  apply({ type: 'submit-result', taskId: 'task-1' })
  apply({ type: 'accept', taskId: 'task-1' })

  const adapter = createAdapter()
  const outcome = await runCoordinationCycle({
    session,
    store: new MemoryTaskCoordinationStore(),
    adapters: registry([['codex', adapter.adapter]]),
    now: fixedNow(NEXT),
  })
  assert.equal(outcome.ok, true)
  assert.equal(adapter.calls.dispatch.length, 0)
  assert.equal(outcome.value.state.records[0].phase, 'needs-input')
  assert.equal(outcome.value.state.records[0].error.code, 'NEEDS_INPUT')
})

test('blocks local-agent dispatch until dependency artifacts are readable', async () => {
  let session = createSession([
    task('task-1', 'deepseek', 'manual'),
    task('task-2', 'codex', 'local-agent', ['task-1']),
  ])
  const apply = (action) => {
    const outcome = updateTaskSession(session, action, NEXT)
    assert.equal(outcome.ok, true, outcome.message)
    session = outcome.session
  }
  apply({ type: 'start', taskId: 'task-1' })
  apply({
    type: 'update-draft', taskId: 'task-1', draft: {
      outputText: 'result', changedFiles: ['src/generated.ts'], reviewNote: '',
      verification: [{ label: 'task-1 accepted', status: 'passed' }],
      handoff: {
        summary: 'Generated code.', keyDecisions: [], openQuestions: [],
        artifacts: [{ path: 'src/generated.ts', description: 'Generated source.' }],
      },
    },
  })
  apply({ type: 'submit-result', taskId: 'task-1' })
  apply({ type: 'accept', taskId: 'task-1' })

  const adapter = createAdapter()
  const outcome = await runCoordinationCycle({
    session,
    store: new MemoryTaskCoordinationStore(),
    adapters: registry([['codex', adapter.adapter]]),
    now: fixedNow(NEXT),
  })
  assert.equal(outcome.ok, true)
  assert.equal(adapter.calls.dispatch.length, 0)
  assert.equal(outcome.value.state.records[0].phase, 'needs-input')
  assert.ok(outcome.value.effects.some(item => item.type === 'execution-needs-input'))
})

test('does not retry unavailable or rate-limited dispatches automatically', async () => {
  const session = createSession([task('task-1', 'codex')])
  const adapter = createAdapter({
    onDispatch() {
      return {
        ok: false,
        error: { code: 'RATE_LIMITED', retryable: true, retryAfterSeconds: 30, message: 'Try later.' },
      }
    },
  })
  const store = new MemoryTaskCoordinationStore()
  const first = await runCoordinationCycle({
    session, store, adapters: registry([['codex', adapter.adapter]]), now: fixedNow(NOW),
  })
  const second = await runCoordinationCycle({
    session, store, adapters: registry([['codex', adapter.adapter]]), now: fixedNow(NEXT),
  })
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(adapter.calls.dispatch.length, 1)
  assert.equal(second.value.state.records[0].phase, 'unknown')
  assert.equal(second.value.state.records[0].error.retryAfterSeconds, 30)
})

test('cancels only through a saved execution reference', async () => {
  const session = createSession([task('task-1', 'codex')])
  const adapter = createAdapter()
  const store = new MemoryTaskCoordinationStore()
  const started = await runCoordinationCycle({
    session, store, adapters: registry([['codex', adapter.adapter]]), now: fixedNow(NOW),
  })
  assert.equal(started.ok, true)
  const cancelled = await cancelCoordinatedTask({
    session, taskId: 'task-1', store,
    adapters: registry([['codex', adapter.adapter]]), now: fixedNow(NEXT),
  })
  assert.equal(cancelled.ok, true, cancelled.error?.message)
  assert.equal(adapter.calls.cancel.length, 1)
  assert.equal(cancelled.value.state.records[0].phase, 'cancelled')
  assert.ok(cancelled.value.effects.some(item => item.type === 'execution-cancelled'))
})

test('strict state validation and stores reject mismatches and oversized data without mutation', async () => {
  const session = createSession([task('task-1', 'codex')])
  const value = {
    schemaVersion: 1,
    sessionId: session.id,
    planId: session.plan.id,
    updatedAt: NOW,
    records: [],
  }
  const before = structuredClone(value)
  assert.equal(validateTaskCoordinationState(value, {
    sessionId: session.id,
    planId: session.plan.id,
    taskIds: ['task-1'],
  }).ok, true)
  assert.deepEqual(value, before)

  const storage = {
    value: 'x'.repeat(MAX_TASK_COORDINATION_BYTES + 1),
    getItem(key) { return key === TASK_COORDINATION_STORAGE_KEY ? this.value : null },
    setItem(_key, next) { this.value = next },
    removeItem() { this.value = null },
  }
  const local = new LocalTaskCoordinationStore(storage)
  const oversized = await local.load({ sessionId: session.id, planId: session.plan.id })
  assert.equal(oversized.ok, false)
  assert.equal(oversized.code, 'LIMIT_EXCEEDED')

  const mismatched = new MemoryTaskCoordinationStore({ ...value, sessionId: 'session-other' })
  const loaded = await mismatched.load({ sessionId: session.id, planId: session.plan.id })
  assert.equal(loaded.ok, false)
  assert.equal(loaded.code, 'CORRUPT_DATA')
})
