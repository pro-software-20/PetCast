/** Test-only renderer entry. Not imported by the application or its production build. */
import React from 'react'
import { createRoot } from 'react-dom/client'
import { TaskAnalysisPanel } from '../src/components/TaskAnalysisPanel'
import { LocalTaskCoordinationStore, TASK_COORDINATION_STORAGE_KEY } from '../src/orchestration/TaskCoordinationStore'
import { LocalTaskSessionStore, TASK_SESSION_STORAGE_KEY } from '../src/orchestration/TaskSessionStore'
import { MapExecutionAdapterRegistry, createStableDispatchId } from '../src/orchestration/taskCoordinator'
import { createTaskSession, updateTaskSession } from '../src/orchestration/taskSession'
import type { ExecutionAdapter, ExecutionDispatchRequest, ExecutionReference, ExecutionSnapshot, TaskCoordinationStateV1 } from '../src/types/taskCoordination'
import type { TaskSessionV1 } from '../src/types/taskOrchestration'
import '../src/styles.css'

const NOW = '2026-11-12T08:00:00.000Z'
const SNAPSHOTS = 'petcast.fixture.recovery.snapshots'
const COUNTS = 'petcast.fixture.recovery.counts'
const FAIL_COORD_SAVE = 'petcast.fixture.recovery.fail-coordination-save'
const FAIL_SESSION_SAVE = 'petcast.fixture.recovery.fail-session-save'
const readJson = <T,>(key: string, fallback: T): T => {
  try { return JSON.parse(localStorage.getItem(key) ?? '') as T } catch { return fallback }
}
const count = (name: string) => {
  const counts = readJson<Record<string, number>>(COUNTS, {})
  counts[name] = (counts[name] ?? 0) + 1
  localStorage.setItem(COUNTS, JSON.stringify(counts))
}
const snapshots = () => readJson<Record<string, ExecutionSnapshot>>(SNAPSHOTS, {})
const putSnapshot = (snapshot: ExecutionSnapshot) => {
  localStorage.setItem(SNAPSHOTS, JSON.stringify({ ...snapshots(), [snapshot.dispatchId]: snapshot }))
}
const failure = { ok: false as const, code: 'STORAGE_UNAVAILABLE' as const, message: '模拟保存失败；未发起新尝试。' }
const coordinationStore = new LocalTaskCoordinationStore()
const guardedCoordinationStore = {
  load: coordinationStore.load.bind(coordinationStore),
  async save(state: TaskCoordinationStateV1) {
    if (localStorage.getItem(FAIL_COORD_SAVE) === '1') return failure
    return coordinationStore.save(state)
  },
  clear: coordinationStore.clear.bind(coordinationStore),
}
const sessionStore = new LocalTaskSessionStore()
const guardedSessionStore = {
  loadLatest: sessionStore.loadLatest.bind(sessionStore),
  async save(session: TaskSessionV1) {
    if (localStorage.getItem(FAIL_SESSION_SAVE) === '1') return failure
    return sessionStore.save(session)
  },
  clear: sessionStore.clear.bind(sessionStore),
}

const adapter: ExecutionAdapter = {
  async dispatch(request: ExecutionDispatchRequest, signal?: AbortSignal) {
    if (signal?.aborted) return { ok: false as const, error: { code: 'CANCELLED' as const, retryable: false, message: '已取消。' } }
    count('dispatch')
    const receipt = { dispatchId: request.dispatchId, adapterExecutionId: `adapter-${request.dispatchId}`,
      taskId: request.taskId, state: 'queued' as const, acceptedAt: new Date().toISOString() }
    putSnapshot({ dispatchId: receipt.dispatchId, adapterExecutionId: receipt.adapterExecutionId,
      taskId: receipt.taskId, state: 'running', observedAt: receipt.acceptedAt })
    return { ok: true as const, value: receipt }
  },
  async inspect(reference: ExecutionReference) {
    count('inspect')
    return { ok: true as const, value: snapshots()[reference.dispatchId] ?? {
      ...reference, state: 'unknown' as const, observedAt: new Date().toISOString(),
      error: { code: 'EXECUTION_NOT_FOUND' as const, retryable: false, message: '外部执行待核对。' },
    } }
  },
  async cancel(reference: ExecutionReference) {
    count('cancel')
    const value: ExecutionSnapshot = { ...reference, state: 'cancelled', observedAt: new Date().toISOString(),
      error: { code: 'CANCELLED', retryable: false, message: '模拟执行已取消。' } }
    putSnapshot(value)
    return { ok: true as const, value }
  },
}
const registry = new MapExecutionAdapterRegistry([['deepseek', adapter], ['doubao', adapter]])

const task = (id: string, providerId: 'deepseek' | 'doubao', dependsOn: string[] = []) => ({
  id, title: `模拟${id}`, description: `完成${id}`, dependsOn,
  recommendedProviderId: providerId, executionMode: 'api' as const, prompt: `完成${id}，只使用模拟数据。`,
  files: { inputs: [], readPaths: [], allowedWritePaths: [], forbiddenPaths: [], outputPaths: [] },
  expectedDeliverables: [`${id}结果`], acceptanceChecks: [`${id}验收`],
})
const seed = (kind: 'unknown' | 'no-receipt' | 'completed' | 'rate-limited' | 'empty' | 'corrupt') => {
  localStorage.clear()
  const tasks = [task('task-1', 'deepseek'), task('task-2', 'doubao')]
  const created = createTaskSession({
    analysisInput: { prompt: '执行两个独立任务。', files: [] },
    analysisResult: { taskType: 'mixed', complexity: 'medium', estimatedInputTokens: { min: 10, max: 20 },
      estimatedOutputTokens: { min: 100, max: 200 }, estimationBasis: 'heuristic-metadata',
      assumptions: ['模拟数据'], optimizedPrompt: '执行两个独立任务。', promptOptimizationSource: 'local',
      canRunInParallel: true, parallelPlan: ['两个根任务'], warnings: [] },
    plan: { schemaVersion: 1, id: 'plan-recovery-ui', title: '恢复验收', goal: '检查桌面异常恢复。',
      assumptions: [], tasks, finalAcceptanceChecks: ['核对结果'] },
  }, NOW)
  if (!created.ok) throw Error(`Fixture session: ${created.message}`)
  let session = created.session
  for (const item of tasks) {
    const updated = updateTaskSession(session, { type: 'set-task-execution-mode', taskId: item.id, executionMode: 'api' }, NOW)
    if (!updated.ok) throw Error(`Fixture mode: ${updated.message}`)
    session = updated.session
  }
  localStorage.setItem(TASK_SESSION_STORAGE_KEY, JSON.stringify(session))
  if (kind === 'corrupt') {
    localStorage.setItem(TASK_COORDINATION_STORAGE_KEY, '{broken')
    return
  }
  if (kind === 'empty') return
  const dispatchId = createStableDispatchId(session.id, session.plan.id, 'task-1', 1, 'deepseek')
  const reference = { dispatchId, adapterExecutionId: `adapter-${dispatchId}`, taskId: 'task-1' }
  const phase = kind === 'no-receipt' ? 'dispatching' : kind === 'rate-limited' ? 'failed' : 'unknown'
  const record = { taskId: 'task-1', providerId: 'deepseek', attempt: 1, dispatchId, phase,
    ...(kind !== 'no-receipt' ? { reference } : {}),
    ...(phase === 'unknown' ? { error: { code: 'EXECUTION_NOT_FOUND', retryable: false, message: '模拟执行待人工核对。' } } : {}),
    ...(kind === 'rate-limited' ? { error: { code: 'RATE_LIMITED', retryable: true, retryAfterSeconds: 60, message: '模拟限流，请稍后核对。' } } : {}),
    createdAt: NOW, updatedAt: NOW }
  localStorage.setItem(TASK_COORDINATION_STORAGE_KEY, JSON.stringify({
    schemaVersion: 1, sessionId: session.id, planId: session.plan.id, updatedAt: NOW, records: [record],
  }))
  if (kind === 'completed') putSnapshot({ ...reference, state: 'completed', observedAt: new Date().toISOString(),
    result: { taskId: 'task-1', providerId: 'deepseek', summary: '模拟任务已完成。',
      outputText: '模拟结果正文。', changedFiles: [], verification: [{ label: 'task-1验收', status: 'not-run' }] } })
  if (kind === 'rate-limited') putSnapshot({ ...reference, state: 'failed', observedAt: new Date().toISOString(),
    error: { code: 'RATE_LIMITED', retryable: true, retryAfterSeconds: 60, message: '模拟限流，请稍后核对。' } })
}

Object.assign(window, {
  recoveryFixture: { seed, counts: () => readJson(COUNTS, {}),
    coordination: () => localStorage.getItem(TASK_COORDINATION_STORAGE_KEY),
    session: () => readJson(TASK_SESSION_STORAGE_KEY, null),
    completePrevious: () => {
      const state = readJson<TaskCoordinationStateV1 | null>(TASK_COORDINATION_STORAGE_KEY, null)
      const record = state?.records[0]
      if (!record?.reference) throw Error('Missing previous execution reference')
      putSnapshot({ ...record.reference, state: 'completed', observedAt: new Date().toISOString(),
        result: { taskId: record.taskId, providerId: record.providerId, summary: '迟到的模拟结果。',
          outputText: '迟到的模拟正文。', changedFiles: [], verification: [{ label: 'task-1验收', status: 'not-run' }] } })
    },
    setFailCoordinationSave: (value: boolean) => localStorage.setItem(FAIL_COORD_SAVE, value ? '1' : '0'),
    setFailSessionSave: (value: boolean) => localStorage.setItem(FAIL_SESSION_SAVE, value ? '1' : '0') },
})
createRoot(document.getElementById('root')!).render(
  <TaskAnalysisPanel coordinationAdapters={registry} coordinationStore={guardedCoordinationStore} sessionStore={guardedSessionStore} />,
)
