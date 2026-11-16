import type { TaskCoordinationStateV1 } from '../types/taskCoordination'
import type { TaskSessionV1 } from '../types/taskOrchestration'
import type { TaskCoordinationStore } from './TaskCoordinationStore'
import type { TaskSessionStore } from './TaskSessionStore'
import { reconcileAndSaveTaskSessionWithCoordination } from './taskCoordinationSession'
import { validateTaskSession } from './taskSessionValidation'

export type TaskRecoveryAction = 'manual-takeover' | 'new-attempt'

export type TaskRecoveryOutcome =
  | { ok: true; state: TaskCoordinationStateV1; session: TaskSessionV1; changed: boolean }
  | { ok: false; code: 'INVALID_INPUT' | 'STATE_MISMATCH' | 'STORAGE_FAILED'; message: string }

const clone = <T>(value: T): T => structuredClone(value)
const fail = (code: Extract<TaskRecoveryOutcome, { ok: false }>['code'], message: string): TaskRecoveryOutcome => ({ ok: false, code, message })

/** Persist the human decision before changing the task session. Never dispatch here. */
export async function resolveTaskCoordination(input: {
  session: TaskSessionV1
  taskId: string
  dispatchId: string
  action: TaskRecoveryAction
  riskAcknowledged: boolean
  coordinationStore: TaskCoordinationStore
  sessionStore: TaskSessionStore
  now?: () => Date
}): Promise<TaskRecoveryOutcome> {
  const checked = validateTaskSession(input.session)
  if (!checked.ok) return fail('INVALID_INPUT', '任务会话未通过严格校验。')
  const loaded = await input.coordinationStore.load({
    sessionId: input.session.id,
    planId: input.session.plan.id,
    taskIds: input.session.plan.tasks.map(task => task.id),
  })
  if (!loaded.ok || !loaded.state) return fail('STORAGE_FAILED', '无法读取协调记录，未发起新尝试。')
  const state = clone(loaded.state)
  const record = [...state.records].filter(item => item.taskId === input.taskId)
    .sort((a, b) => b.attempt - a.attempt)[0]
  const run = input.session.runs.find(item => item.taskId === input.taskId)
  const task = input.session.plan.tasks.find(item => item.id === input.taskId)
  if (!record || !run || !task || record.dispatchId !== input.dispatchId
    || record.providerId !== run.assignedProviderId || task.executionMode === 'manual'
    || !['unknown', 'failed', 'cancelled', 'needs-input'].includes(record.phase)) {
    return fail('STATE_MISMATCH', '执行状态或派发记录已变化，请重新核对。')
  }
  if (record.resolution) {
    if (record.resolution.action !== input.action) return fail('STATE_MISMATCH', '这次派发已有不同的人工处理决定。')
    const reconciled = await reconcileAndSaveTaskSessionWithCoordination({
      session: input.session,
      coordinationState: state,
      store: input.sessionStore,
    })
    if (!reconciled.ok) return fail('STORAGE_FAILED', '人工决定已保存，但任务会话尚未保存；请重新检查恢复。')
    return { ok: true, state, session: reconciled.session, changed: reconciled.changed }
  }
  if (!['ready', 'needs-input', 'failed', 'cancelled'].includes(run.status)
    || record.attempt < run.attempt || record.attempt > run.attempt + 1) {
    return fail('STATE_MISMATCH', '当前任务已经开始新的处理，不能重复决定。')
  }
  const uncertain = !record.reference || ['unknown', 'needs-input'].includes(record.phase)
  if (input.action === 'new-attempt' && uncertain && !input.riskAcknowledged) {
    return fail('INVALID_INPUT', '必须单独确认旧执行可能继续、重复调用或计费的风险。')
  }
  const at = (input.now?.() ?? new Date()).toISOString()
  record.resolution = {
    action: input.action,
    dispatchId: record.dispatchId,
    confirmedAt: at,
    riskAcknowledged: input.action === 'new-attempt' && uncertain,
  }
  record.updatedAt = at
  state.updatedAt = at
  const saved = await input.coordinationStore.save(state)
  if (!saved.ok) return fail('STORAGE_FAILED', '人工处理决定未保存，未发起新尝试。')
  const reconciled = await reconcileAndSaveTaskSessionWithCoordination({
    session: input.session,
    coordinationState: state,
    store: input.sessionStore,
  })
  if (!reconciled.ok) return fail('STORAGE_FAILED', '人工决定已保存，但任务会话尚未保存；请重新检查恢复。')
  return { ok: true, state, session: reconciled.session, changed: reconciled.changed }
}
