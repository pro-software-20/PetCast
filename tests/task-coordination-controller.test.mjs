import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTs } from './load-ts.mjs'

const {
  createTaskCoordinationController,
} = await loadTs('../src/orchestration/TaskCoordinationController.ts')
const {
  MapExecutionAdapterRegistry,
  createStableDispatchId,
} = await loadTs('../src/orchestration/taskCoordinator.ts')
const { MemoryTaskCoordinationStore } = await loadTs('../src/orchestration/TaskCoordinationStore.ts')
const { MemoryTaskCoordinationAuditStore } = await loadTs('../src/orchestration/TaskCoordinationAuditStore.ts')
const { createTaskSession } = await loadTs('../src/orchestration/taskSession.ts')

const NOW = '2026-11-06T08:00:00.000Z'
const NEXT = '2026-11-06T08:00:02.000Z'

const analysisResult = {
  taskType: 'coding',
  complexity: 'medium',
  estimatedInputTokens: { min: 10, max: 20 },
  estimatedOutputTokens: { min: 100, max: 200 },
  estimationBasis: 'heuristic-metadata',
  assumptions: ['metadata only'],
  optimizedPrompt: 'Implement the task.',
  promptOptimizationSource: 'local',
  canRunInParallel: false,
  parallelPlan: ['Run serially.'],
  warnings: [],
}

const createSession = () => {
  const created = createTaskSession({
    analysisInput: { prompt: 'Implement the task.', files: [] },
    analysisResult,
    plan: {
      schemaVersion: 1,
      id: 'plan-controller',
      title: 'Controller plan',
      goal: 'Exercise the coordination controller.',
      assumptions: ['The adapter is a fixture.'],
      tasks: [{
        id: 'task-1',
        title: 'Implement',
        description: 'Implement the requested change.',
        dependsOn: [],
        recommendedProviderId: 'deepseek',
        executionMode: 'api',
        prompt: 'Implement the requested change.',
        files: {
          inputs: [], readPaths: [], allowedWritePaths: [], forbiddenPaths: [], outputPaths: [],
        },
        expectedDeliverables: ['Implementation'],
        acceptanceChecks: ['Implementation accepted'],
      }],
      finalAcceptanceChecks: ['All tasks complete'],
    },
  }, NOW)
  assert.equal(created.ok, true, created.message)
  return created.session
}

const createSessionStore = () => ({
  saved: [],
  async loadLatest() { return { ok: true, session: null } },
  async save(session) { this.saved.push(structuredClone(session)); return { ok: true } },
  async clear() { return { ok: true } },
})

const createAdapter = () => {
  const calls = { dispatch: [], inspect: [], cancel: [] }
  return {
    calls,
    adapter: {
      async dispatch(request) {
        calls.dispatch.push(structuredClone(request))
        return {
          ok: true,
          value: {
            dispatchId: request.dispatchId,
            adapterExecutionId: `adapter-${request.dispatchId}`,
            taskId: request.taskId,
            state: 'queued',
            acceptedAt: NOW,
          },
        }
      },
      async inspect(reference) {
        calls.inspect.push(structuredClone(reference))
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
    },
  }
}

const snapshotCollector = (controller) => {
  const snapshots = []
  const unsubscribe = controller.subscribe(value => snapshots.push(value))
  return { snapshots, unsubscribe, latest: () => snapshots.at(-1) }
}

test('requires runtime confirmation before dispatch and pause stops future polling', async () => {
  const adapter = createAdapter()
  const sessions = createSessionStore()
  const controller = createTaskCoordinationController({
    session: createSession(),
    coordinationStore: new MemoryTaskCoordinationStore(),
    sessionStore: sessions,
    adapters: new MapExecutionAdapterRegistry([['deepseek', adapter.adapter]]),
    policy: { pollIntervalMs: 60_000 },
    now: () => new Date(NOW),
  })
  const observed = snapshotCollector(controller)
  assert.equal(observed.latest().status, 'paused')

  await controller.resume()
  assert.equal(observed.latest().status, 'confirming')
  assert.equal(adapter.calls.dispatch.length, 0)
  assert.deepEqual(observed.latest().dispatchPreview?.dispatchable.map(item => item.taskId), ['task-1'])

  await controller.start()
  assert.equal(adapter.calls.dispatch.length, 1)
  assert.equal(sessions.saved.at(-1).runs[0].status, 'running')
  controller.pause()
  assert.equal(observed.latest().status, 'paused')
  controller.dispose()
  observed.unsubscribe()
})

test('every user initiated resume requires a fresh queue confirmation', async () => {
  const adapter = createAdapter()
  const controller = createTaskCoordinationController({
    session: createSession(),
    coordinationStore: new MemoryTaskCoordinationStore(),
    sessionStore: createSessionStore(),
    adapters: new MapExecutionAdapterRegistry([['deepseek', adapter.adapter]]),
    policy: { pollIntervalMs: 60_000 },
    now: () => new Date(NOW),
  })

  await controller.start()
  assert.equal(adapter.calls.dispatch.length, 0)
  await controller.start()
  assert.equal(adapter.calls.dispatch.length, 1)
  controller.pause()

  await controller.resume()
  assert.equal(adapter.calls.dispatch.length, 1)
  const states = []
  const unsubscribe = controller.subscribe(snapshot => states.push(snapshot.status))
  assert.equal(states.at(-1), 'confirming')
  await controller.resume()
  assert.equal(adapter.calls.dispatch.length, 1)
  controller.dispose()
  unsubscribe()
})

test('paused manual checks inspect persisted executions without redispatching', async () => {
  const session = createSession()
  const dispatchId = createStableDispatchId(session.id, session.plan.id, 'task-1', 1, 'deepseek')
  const coordinationStore = new MemoryTaskCoordinationStore({
    schemaVersion: 1,
    sessionId: session.id,
    planId: session.plan.id,
    updatedAt: NOW,
    records: [{
      taskId: 'task-1',
      providerId: 'deepseek',
      attempt: 1,
      dispatchId,
      phase: 'queued',
      reference: { dispatchId, adapterExecutionId: `adapter-${dispatchId}`, taskId: 'task-1' },
      createdAt: NOW,
      updatedAt: NOW,
    }],
  })
  const adapter = createAdapter()
  const controller = createTaskCoordinationController({
    session,
    coordinationStore,
    sessionStore: createSessionStore(),
    adapters: new MapExecutionAdapterRegistry([['deepseek', adapter.adapter]]),
    now: () => new Date(NEXT),
  })

  await controller.runNow()
  assert.equal(adapter.calls.inspect.length, 1)
  assert.equal(adapter.calls.dispatch.length, 0)
  controller.dispose()
})

test('rehydrates completed execution evidence after restart without inspecting or redispatching', async () => {
  const session = createSession()
  const dispatchId = createStableDispatchId(session.id, session.plan.id, 'task-1', 1, 'deepseek')
  const result = {
    taskId: 'task-1',
    providerId: 'deepseek',
    summary: 'Completed implementation summary.',
    outputText: 'Completed implementation summary.',
    changedFiles: [],
    verification: [{ label: 'Implementation accepted', status: 'passed', details: 'Fixture verification passed.' }],
  }
  const coordinationStore = new MemoryTaskCoordinationStore({
    schemaVersion: 1,
    sessionId: session.id,
    planId: session.plan.id,
    updatedAt: NEXT,
    records: [{
      taskId: 'task-1',
      providerId: 'deepseek',
      attempt: 1,
      dispatchId,
      phase: 'completed',
      reference: { dispatchId, adapterExecutionId: `adapter-${dispatchId}`, taskId: 'task-1' },
      latestSnapshot: {
        dispatchId,
        adapterExecutionId: `adapter-${dispatchId}`,
        taskId: 'task-1',
        state: 'completed',
        observedAt: NEXT,
        result,
      },
      createdAt: NOW,
      updatedAt: NEXT,
    }],
  })
  const adapter = createAdapter()
  const controller = createTaskCoordinationController({
    session,
    coordinationStore,
    sessionStore: createSessionStore(),
    adapters: new MapExecutionAdapterRegistry([['deepseek', adapter.adapter]]),
  })
  const observed = snapshotCollector(controller)

  await controller.hydrate()

  assert.equal(observed.latest().status, 'paused')
  assert.equal(observed.latest().error, undefined)
  assert.equal(observed.latest().records.length, 1)
  assert.equal(observed.latest().records[0].dispatchId, dispatchId)
  assert.equal(observed.latest().records[0].phase, 'completed')
  assert.equal(adapter.calls.dispatch.length, 0)
  assert.equal(adapter.calls.inspect.length, 0)
  controller.dispose()
  observed.unsubscribe()
})

test('cancel uses the registered adapter and reconciles the task safely', async () => {
  const adapter = createAdapter()
  const sessions = createSessionStore()
  const controller = createTaskCoordinationController({
    session: createSession(),
    coordinationStore: new MemoryTaskCoordinationStore(),
    sessionStore: sessions,
    adapters: new MapExecutionAdapterRegistry([['deepseek', adapter.adapter]]),
    policy: { pollIntervalMs: 60_000 },
    now: () => new Date(NOW),
  })
  await controller.resume()
  await controller.start()
  controller.pause()
  await controller.cancelTask('task-1')

  assert.equal(adapter.calls.cancel.length, 1)
  assert.equal(sessions.saved.at(-1).runs[0].status, 'cancelled')
  controller.dispose()
})

test('cancel during dispatch waits for receipt and cancels without redispatch', async () => {
  const adapter = createAdapter()
  const originalDispatch = adapter.adapter.dispatch
  let release, entered
  const gate = new Promise(resolve => { release = resolve })
  const dispatched = new Promise(resolve => { entered = resolve })
  adapter.adapter.dispatch = async request => { entered(); await gate; return originalDispatch(request) }
  const sessions = createSessionStore()
  const controller = createTaskCoordinationController({
    session: createSession(), coordinationStore: new MemoryTaskCoordinationStore(),
    sessionStore: sessions, adapters: new MapExecutionAdapterRegistry([['deepseek', adapter.adapter]]),
    policy: { pollIntervalMs: 60_000 }, now: () => new Date(NOW),
  })
  try {
    await controller.resume()
    const starting = controller.start()
    await dispatched
    const stopping = controller.cancelTask('task-1')
    release()
    await Promise.all([starting, stopping])
    assert.equal(adapter.calls.dispatch.length, 1)
    assert.equal(adapter.calls.cancel.length, 1)
    assert.equal(sessions.saved.at(-1).runs[0].status, 'cancelled')
  } finally { release(); controller.dispose() }
})

test('empty adapter registry never creates a simulated execution', async () => {
  const controller = createTaskCoordinationController({
    session: createSession(),
    coordinationStore: new MemoryTaskCoordinationStore(),
    sessionStore: createSessionStore(),
    adapters: new MapExecutionAdapterRegistry(),
  })
  const observed = snapshotCollector(controller)
  await controller.start()
  assert.equal(observed.latest().status, 'waiting-user')
  assert.match(observed.latest().error, /人工执行/)
  controller.dispose()
  observed.unsubscribe()
})

test('records a sanitised audit trail without making coordination depend on audit storage', async () => {
  const adapter = createAdapter()
  const auditStore = new MemoryTaskCoordinationAuditStore()
  const controller = createTaskCoordinationController({
    session: createSession(),
    coordinationStore: new MemoryTaskCoordinationStore(),
    sessionStore: createSessionStore(),
    adapters: new MapExecutionAdapterRegistry([['deepseek', adapter.adapter]]),
    auditStore,
    policy: { pollIntervalMs: 60_000 },
    now: () => new Date(NOW),
  })

  await controller.start()
  await controller.start()
  controller.pause()
  await new Promise(resolve => setTimeout(resolve, 0))

  const events = auditStore.peek()?.events ?? []
  assert.ok(events.some(event => event.type === 'confirmation-requested'))
  assert.ok(events.some(event => event.type === 'coordination-started'))
  assert.ok(events.some(event => event.type === 'dispatch-intended'))
  assert.ok(events.some(event => event.type === 'dispatch-accepted'))
  assert.ok(events.some(event => event.type === 'coordination-paused'))
  assert.equal(JSON.stringify(events).includes('Authorization'), false)
  controller.dispose()
})
