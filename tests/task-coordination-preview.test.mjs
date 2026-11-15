import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTs } from './load-ts.mjs'

const {
  MapExecutionAdapterRegistry,
  previewTaskCoordinationDispatch,
  runCoordinationCycle,
} = await loadTs('../src/orchestration/taskCoordinator.ts')
const { MemoryTaskCoordinationStore } = await loadTs('../src/orchestration/TaskCoordinationStore.ts')
const { createTaskSession } = await loadTs('../src/orchestration/taskSession.ts')

const NOW = '2026-11-13T08:00:00.000Z'
const analysisResult = {
  taskType: 'mixed', complexity: 'medium', estimatedInputTokens: { min: 1, max: 2 },
  estimatedOutputTokens: { min: 1, max: 2 }, estimationBasis: 'heuristic-metadata',
  assumptions: ['fixture'], optimizedPrompt: 'Fixture', promptOptimizationSource: 'local',
  canRunInParallel: true, parallelPlan: [], warnings: [],
}

const createSession = () => {
  const result = createTaskSession({
    analysisInput: { prompt: 'Fixture', files: [] },
    analysisResult,
    plan: {
      schemaVersion: 1, id: 'plan-preview', title: 'Preview', goal: 'Exercise the dispatch preview.', assumptions: ['fixture'],
      tasks: [
        { id: 'high', title: 'High priority', description: 'High', dependsOn: [], recommendedProviderId: 'deepseek', executionMode: 'api', priority: 'high', prompt: 'High', files: { inputs: [], readPaths: [], allowedWritePaths: [], forbiddenPaths: [], outputPaths: [] }, expectedDeliverables: ['High'], acceptanceChecks: ['High check'] },
        { id: 'critical', title: 'Critical path', description: 'Critical', dependsOn: [], recommendedProviderId: 'codex', executionMode: 'api', priority: 'medium', prompt: 'Critical', files: { inputs: [], readPaths: [], allowedWritePaths: [], forbiddenPaths: [], outputPaths: [] }, expectedDeliverables: ['Critical'], acceptanceChecks: ['Critical check'] },
        { id: 'summary', title: 'Summary', description: 'Summary', dependsOn: ['critical'], recommendedProviderId: 'doubao', executionMode: 'api', priority: 'medium', prompt: 'Summary', files: { inputs: [], readPaths: [], allowedWritePaths: [], forbiddenPaths: [], outputPaths: [] }, expectedDeliverables: ['Summary'], acceptanceChecks: ['Summary check'] },
        { id: 'manual', title: 'Manual', description: 'Manual', dependsOn: [], recommendedProviderId: 'local', executionMode: 'manual', priority: 'low', prompt: 'Manual', files: { inputs: [], readPaths: [], allowedWritePaths: [], forbiddenPaths: [], outputPaths: [] }, expectedDeliverables: ['Manual'], acceptanceChecks: ['Manual check'] },
      ],
      finalAcceptanceChecks: ['All done'],
    },
  }, NOW)
  assert.equal(result.ok, true, result.message)
  return result.session
}

const createAdapter = calls => ({
  async dispatch(request) {
    calls.push(request.taskId)
    return { ok: true, value: { dispatchId: request.dispatchId, adapterExecutionId: `fixture-${request.taskId}`, taskId: request.taskId, state: 'queued', acceptedAt: NOW } }
  },
  async inspect(reference) {
    return { ok: true, value: { ...reference, state: 'queued', observedAt: NOW } }
  },
  async cancel(reference) {
    return { ok: true, value: { ...reference, state: 'cancelled', observedAt: NOW, error: { code: 'CANCELLED', retryable: false, message: 'cancelled' } } }
  },
})

test('dispatch preview matches the actual priority-ordered dispatch set', async () => {
  const session = createSession()
  const calls = []
  const adapter = createAdapter(calls)
  const adapters = new MapExecutionAdapterRegistry([['deepseek', adapter], ['codex', adapter]])
  const preview = previewTaskCoordinationDispatch(session, [], adapters)
  assert.equal(preview.ok, true)
  assert.deepEqual(preview.value.dispatchable.map(item => item.taskId), ['high', 'critical'])
  assert.equal(preview.value.dispatchable[1].isCriticalPath, true)
  assert.deepEqual(preview.value.providerCapacity, [
    { providerId: 'codex', activeCount: 0, availableSlots: 1, capacity: 1 },
    { providerId: 'deepseek', activeCount: 0, availableSlots: 1, capacity: 1 },
    { providerId: 'doubao', activeCount: 0, availableSlots: 1, capacity: 1 },
  ])
  assert.match(preview.value.dispatchable[0].reasons.join(' '), /原任务顺序：1/)
  assert.match(preview.value.excluded.find(item => item.taskId === 'summary').reason, /等待前置任务/)
  assert.match(preview.value.excluded.find(item => item.taskId === 'manual').reason, /人工执行/)

  const cycle = await runCoordinationCycle({
    session, store: new MemoryTaskCoordinationStore(), adapters, now: () => new Date(NOW),
  })
  assert.equal(cycle.ok, true)
  assert.deepEqual(calls, preview.value.dispatchable.map(item => item.taskId))
})

test('preview explains provider capacity and does not mutate inputs', () => {
  const session = createSession()
  session.plan.tasks[1].recommendedProviderId = 'deepseek'
  session.runs[1].assignedProviderId = 'deepseek'
  const before = structuredClone(session)
  const adapter = createAdapter([])
  const preview = previewTaskCoordinationDispatch(
    session,
    [],
    new MapExecutionAdapterRegistry([['deepseek', adapter]]),
    { globalConcurrency: 2, providerConcurrency: 1 },
  )
  assert.equal(preview.ok, true)
  assert.deepEqual(preview.value.dispatchable.map(item => item.taskId), ['high'])
  assert.match(preview.value.excluded.find(item => item.taskId === 'critical').reason, /并发容量已满/)
  assert.deepEqual(session, before)
})
