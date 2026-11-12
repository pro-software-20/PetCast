import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTs } from './load-ts.mjs'

const { createTaskSession, updateTaskSession } = await loadTs('../src/orchestration/taskSession.ts')
const { MemoryTaskCoordinationStore } = await loadTs('../src/orchestration/TaskCoordinationStore.ts')
const { createStableDispatchId, runCoordinationCycle, MapExecutionAdapterRegistry } = await loadTs('../src/orchestration/taskCoordinator.ts')
const { resolveTaskCoordination } = await loadTs('../src/orchestration/taskCoordinationRecovery.ts')
const { reconcileTaskSessionWithCoordination } = await loadTs('../src/orchestration/taskCoordinationSession.ts')
const { createTaskCoordinationController } = await loadTs('../src/orchestration/TaskCoordinationController.ts')

const NOW = '2026-11-12T08:00:00.000Z'
const NEXT = '2026-11-12T08:01:00.000Z'
const analysisResult = {
  taskType: 'mixed', complexity: 'medium',
  estimatedInputTokens: { min: 10, max: 20 }, estimatedOutputTokens: { min: 100, max: 200 },
  estimationBasis: 'heuristic-metadata', assumptions: ['Fixture only'],
  optimizedPrompt: 'Complete the tasks.', promptOptimizationSource: 'local',
  canRunInParallel: true, parallelPlan: ['Independent roots'], warnings: [],
}
const task = (id, providerId, dependsOn = []) => ({
  id, title: id, description: `Complete ${id}.`, dependsOn,
  recommendedProviderId: providerId, executionMode: 'api', prompt: `Complete ${id}.`,
  files: { inputs: [], readPaths: [], allowedWritePaths: [], forbiddenPaths: [], outputPaths: [] },
  expectedDeliverables: [`${id} result`], acceptanceChecks: [`${id} accepted`],
})
const createSession = (tasks = [task('task-1', 'deepseek')]) => {
  const created = createTaskSession({
    analysisInput: { prompt: 'Complete the tasks.', files: [] }, analysisResult,
    plan: { schemaVersion: 1, id: 'plan-recovery', title: 'Recovery', goal: 'Check recovery.',
      assumptions: [], tasks, finalAcceptanceChecks: ['Review all tasks'] },
  }, NOW)
  assert.equal(created.ok, true, created.message)
  return created.session
}
const recordFor = (session, taskId = 'task-1', phase = 'unknown', reference = undefined, attempt = 1) => {
  const providerId = session.plan.tasks.find(item => item.id === taskId).recommendedProviderId
  const dispatchId = createStableDispatchId(session.id, session.plan.id, taskId, attempt, providerId)
  return {
    taskId, providerId, attempt, dispatchId, phase,
    ...(reference ? { reference: { taskId, dispatchId, adapterExecutionId: `adapter-${dispatchId}` } } : {}),
    ...(['unknown', 'failed'].includes(phase) ? { error: { code: 'FAILED', retryable: false, message: 'Safe fixture error.', retryAfterSeconds: 30 } } : {}),
    createdAt: NOW, updatedAt: NOW,
  }
}
const stateFor = (session, records) => ({ schemaVersion: 1, sessionId: session.id,
  planId: session.plan.id, updatedAt: NOW, records })
const sessionStore = (initial, fail = false) => ({
  latest: structuredClone(initial), writes: 0, fail,
  async loadLatest() { return { ok: true, session: structuredClone(this.latest) } },
  async save(value) {
    if (this.fail) { this.fail = false; return { ok: false, code: 'STORAGE_UNAVAILABLE', message: 'Fixture failure.' } }
    this.latest = structuredClone(value); this.writes++; return { ok: true }
  },
  async clear() { return { ok: true } },
})
const resolve = (session, record, coordinationStore, store, action, riskAcknowledged = false) =>
  resolveTaskCoordination({ session, taskId: record.taskId, dispatchId: record.dispatchId,
    action, riskAcknowledged, coordinationStore, sessionStore: store, now: () => new Date(NEXT) })

test('receipt-less dispatch stays unknown; explicit risk confirmation creates a new stable attempt without deleting evidence', async () => {
  const session = createSession()
  const intent = recordFor(session, 'task-1', 'dispatching')
  const coordinationStore = new MemoryTaskCoordinationStore(stateFor(session, [intent]))
  let dispatches = 0
  const adapters = new MapExecutionAdapterRegistry([['deepseek', { dispatch: async () => { dispatches++; throw Error('unexpected dispatch') } }]])
  const recovered = await runCoordinationCycle({ session, store: coordinationStore, adapters, now: () => new Date(NEXT), canDispatch: () => false })
  assert.equal(recovered.ok, true)
  assert.equal(recovered.value.state.records[0].phase, 'unknown')
  assert.equal(dispatches, 0)
  const store = sessionStore(session)
  const record = recovered.value.state.records[0]
  const denied = await resolve(session, record, coordinationStore, store, 'new-attempt')
  assert.equal(denied.ok, false)
  assert.equal(store.writes, 0)
  const approved = await resolve(session, record, coordinationStore, store, 'new-attempt', true)
  assert.equal(approved.ok, true, approved.message)
  assert.equal(approved.session.runs[0].status, 'ready')
  assert.equal(approved.session.runs[0].attempt, 1)
  assert.equal(coordinationStore.peek().records.length, 1)
  assert.equal(coordinationStore.peek().records[0].resolution.riskAcknowledged, true)
  const again = await resolve(approved.session, record, coordinationStore, store, 'new-attempt', true)
  assert.equal(again.ok, true)
  assert.equal(again.changed, false)
  const nextId = createStableDispatchId(session.id, session.plan.id, 'task-1', 2, 'deepseek')
  assert.notEqual(nextId, record.dispatchId)
  const requests = []
  const dispatched = await runCoordinationCycle({ session: approved.session, store: coordinationStore,
    adapters: new MapExecutionAdapterRegistry([['deepseek', {
      async dispatch(request) {
        requests.push(request)
        return { ok: true, value: { dispatchId: request.dispatchId, taskId: request.taskId,
          adapterExecutionId: 'adapter-second', state: 'queued', acceptedAt: NEXT } }
      },
    }]]), now: () => new Date(NEXT), canDispatch: () => true })
  assert.equal(dispatched.ok, true, dispatched.error?.message)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].dispatchId, nextId)
  assert.equal(dispatched.value.state.records.length, 2)
  assert.equal(dispatched.value.state.records[0].resolution.action, 'new-attempt')
  assert.equal(dispatched.value.state.records[1].attempt, 2)
  const late = reconcileTaskSessionWithCoordination({ session: approved.session,
    coordinationState: stateFor(session, [coordinationStore.peek().records[0]]), effects: [{ type: 'execution-completed', taskId: 'task-1',
      providerId: 'deepseek', attempt: 1, dispatchId: record.dispatchId, occurredAt: NEXT }] })
  assert.equal(late.ok, true)
  assert.equal(late.changed, false)
})

test('failed coordination save leaves session unchanged and cannot dispatch', async () => {
  const session = createSession([task('task-1', 'deepseek'), task('task-2', 'doubao')])
  const record = recordFor(session)
  let writes = 0
  const coordinationStore = {
    async load() { return { ok: true, state: stateFor(session, [record]) } },
    async save() { writes++; return { ok: false, code: 'STORAGE_UNAVAILABLE', message: 'Fixture failure.' } },
    async clear() { return { ok: true } },
  }
  const store = sessionStore(session)
  const outcome = await resolve(session, record, coordinationStore, store, 'new-attempt', true)
  assert.equal(outcome.ok, false)
  assert.equal(writes, 1)
  assert.equal(store.writes, 0)
  assert.equal(session.runs[1].status, 'ready')
})

test('uncertain reference can later complete; user cannot retry before checking that result', async () => {
  const session = createSession()
  const record = recordFor(session, 'task-1', 'unknown', true)
  const coordinationStore = new MemoryTaskCoordinationStore(stateFor(session, [record]))
  const store = sessionStore(session)
  const result = { taskId: 'task-1', providerId: 'deepseek', summary: 'Done.', outputText: 'Done safely.',
    changedFiles: [], verification: [{ label: 'task-1 accepted', status: 'not-run' }] }
  const adapters = new MapExecutionAdapterRegistry([['deepseek', {
    async inspect(reference) { return { ok: true, value: { ...reference, state: 'completed', observedAt: NEXT, result } } },
  }]])
  const cycle = await runCoordinationCycle({ session, store: coordinationStore, adapters, now: () => new Date(NEXT), canDispatch: () => false })
  assert.equal(cycle.ok, true)
  const review = reconcileTaskSessionWithCoordination({ session, coordinationState: cycle.value.state })
  assert.equal(review.ok, true, review.message)
  assert.equal(review.session.runs[0].status, 'review')
  const denied = await resolve(review.session, record, coordinationStore, store, 'new-attempt', true)
  assert.equal(denied.ok, false)
})

test('explicit recovery check can discover completion after a reported failure', async () => {
  const session = createSession()
  const record = recordFor(session, 'task-1', 'failed', true)
  const state = stateFor(session, [record])
  const failed = reconcileTaskSessionWithCoordination({ session, coordinationState: state })
  assert.equal(failed.ok, true, failed.message)
  assert.equal(failed.session.runs[0].status, 'failed')
  const coordinationStore = new MemoryTaskCoordinationStore(state)
  const result = { taskId: 'task-1', providerId: 'deepseek', summary: 'Recovered.',
    changedFiles: [], verification: [{ label: 'task-1 accepted', status: 'not-run' }] }
  let inspected = 0
  const adapters = new MapExecutionAdapterRegistry([['deepseek', {
    async inspect(reference) { inspected++; return { ok: true, value: { ...reference, state: 'completed', observedAt: NEXT, result } } },
  }]])
  const store = sessionStore(failed.session)
  const controller = createTaskCoordinationController({ session: failed.session, coordinationStore,
    sessionStore: store, adapters, now: () => new Date(NEXT) })
  let latest
  controller.subscribe(value => { latest = value })
  await controller.resolveTask('task-1', record.dispatchId, 'new-attempt', false)
  assert.equal(inspected, 1)
  assert.equal(latest.status, 'paused')
  assert.equal(latest.records[0].phase, 'completed')
  assert.equal(store.latest.runs[0].status, 'review')
  assert.equal(coordinationStore.peek().records[0].resolution, undefined)
  assert.match(latest.notices[0].message, /待验收/)
  controller.dispose()
})

test('manual takeover persists first, replays after session save failure, then permits human result entry', async () => {
  const session = createSession()
  const record = recordFor(session)
  const coordinationStore = new MemoryTaskCoordinationStore(stateFor(session, [record]))
  const store = sessionStore(session, true)
  const failed = await resolve(session, record, coordinationStore, store, 'manual-takeover')
  assert.equal(failed.ok, false)
  assert.equal(coordinationStore.peek().records[0].resolution.action, 'manual-takeover')
  assert.equal(store.latest.runs[0].status, 'ready')
  const replayed = await resolve(session, record, coordinationStore, store, 'manual-takeover')
  assert.equal(replayed.ok, true, replayed.message)
  assert.equal(replayed.session.runs[0].executionMode, 'manual')
  assert.equal(replayed.session.runs[0].status, 'running')
  const edited = updateTaskSession(replayed.session, { type: 'update-draft', taskId: 'task-1', draft: { outputText: 'Manual result.' } }, NEXT)
  assert.equal(edited.ok, true, edited.message)
  const submitted = updateTaskSession(edited.session, { type: 'submit-result', taskId: 'task-1' }, NEXT)
  assert.equal(submitted.ok, true, submitted.message)
  const unaffected = reconcileTaskSessionWithCoordination({ session: submitted.session, coordinationState: coordinationStore.peek() })
  assert.equal(unaffected.ok, true, unaffected.message)
  assert.equal(unaffected.session.runs[0].status, 'review')
})

test('failed and cancelled attempts cannot use generic retry; a resolved attempt requires explicit restart', async () => {
  for (const phase of ['failed', 'cancelled']) {
    let session = createSession()
    const record = recordFor(session, 'task-1', phase, true)
    const state = stateFor(session, [record])
    const bridged = reconcileTaskSessionWithCoordination({ session, coordinationState: state })
    assert.equal(bridged.ok, true, bridged.message)
    session = bridged.session
    assert.equal(session.runs[0].status, phase)
    const shortcut = updateTaskSession(session, { type: 'retry', taskId: 'task-1' }, NEXT)
    assert.equal(shortcut.ok, false)
    const coordinationStore = new MemoryTaskCoordinationStore(state)
    const store = sessionStore(session)
    const recovery = await resolve(session, record, coordinationStore, store, 'new-attempt')
    assert.equal(recovery.ok, true, recovery.message)
    assert.equal(recovery.session.runs[0].status, 'ready')
    const controller = createTaskCoordinationController({ session: recovery.session, coordinationStore,
      sessionStore: store, adapters: new MapExecutionAdapterRegistry(), now: () => new Date(NEXT) })
    let latest
    controller.subscribe(value => { latest = value })
    assert.equal(latest.status, 'paused')
    assert.equal(coordinationStore.peek().records.length, 1)
    controller.dispose()
  }
})

test('coordination record cannot be cleared while execution evidence remains', async () => {
  const session = createSession()
  const record = recordFor(session)
  const coordinationStore = new MemoryTaskCoordinationStore(stateFor(session, [record]))
  const controller = createTaskCoordinationController({ session, coordinationStore,
    sessionStore: sessionStore(session), adapters: new MapExecutionAdapterRegistry(), now: () => new Date(NEXT) })
  let latest
  controller.subscribe(value => { latest = value })
  await controller.clearState()
  assert.equal(coordinationStore.peek().records.length, 1)
  assert.match(latest.error, /不能清除/)
  controller.dispose()
})

test('damaged coordination storage is retained and cannot be cleared by the controller', async () => {
  const session = createSession()
  let clears = 0
  const coordinationStore = {
    async load() { return { ok: false, code: 'CORRUPT_DATA', message: 'Corrupt fixture.' } },
    async save() { return { ok: false, code: 'CORRUPT_DATA', message: 'Corrupt fixture.' } },
    async clear() { clears++; return { ok: true } },
  }
  const controller = createTaskCoordinationController({ session, coordinationStore,
    sessionStore: sessionStore(session), adapters: new MapExecutionAdapterRegistry() })
  let latest
  controller.subscribe(value => { latest = value })
  await controller.clearState()
  assert.equal(clears, 0)
  assert.match(latest.error, /Corrupt/)
  controller.dispose()
})
