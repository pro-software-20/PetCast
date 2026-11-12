import type {
  ExecutionAdapterError,
  TaskCoordinationEffect,
  TaskCoordinationRecord,
  TaskCoordinationStateV1,
} from '../types/taskCoordination'
import type {
  TaskExecutionResult,
  TaskSessionV1,
} from '../types/taskOrchestration'
import type { TaskSessionStore } from './TaskSessionStore'
import { updateTaskSession } from './taskSession'
import { validateTaskCoordinationState } from './taskCoordinationStateValidation'
import {
  validateExecutionReference,
  validateExecutionSnapshot,
} from './taskCoordinationValidation'
import { validateTaskSession } from './taskSessionValidation'

export interface ReconcileTaskCoordinationInput {
  session: TaskSessionV1
  coordinationState: TaskCoordinationStateV1
  effects?: TaskCoordinationEffect[]
}

export type TaskCoordinationNoticeCode =
  | 'PRE_DISPATCH_BLOCKED'
  | 'MANUAL_REVIEW_REQUIRED'
  | 'STALE_EFFECT'
  | 'RESULT_MISMATCH'

export interface TaskCoordinationNotice {
  taskId: string
  dispatchId: string
  level: 'info' | 'warning' | 'error'
  code: TaskCoordinationNoticeCode
  message: string
}

export type ReconcileTaskCoordinationErrorCode =
  | 'INVALID_INPUT'
  | 'STATE_MISMATCH'
  | 'INVALID_RESULT'

export type ReconcileTaskCoordinationOutcome =
  | {
      ok: true
      session: TaskSessionV1
      changed: boolean
      notices: TaskCoordinationNotice[]
    }
  | {
      ok: false
      code: ReconcileTaskCoordinationErrorCode
      message: string
    }

export type PersistTaskCoordinationOutcome =
  | ReconcileTaskCoordinationOutcome
  | {
      ok: false
      code: 'STORAGE_FAILED'
      message: string
      session: TaskSessionV1
    }

const EFFECT_KEYS = new Set([
  'type',
  'taskId',
  'providerId',
  'attempt',
  'dispatchId',
  'occurredAt',
  'reference',
  'snapshot',
  'error',
])

const EFFECT_TYPES = new Set([
  'dispatch-accepted',
  'execution-running',
  'execution-needs-input',
  'execution-completed',
  'execution-failed',
  'execution-cancelled',
  'execution-unknown',
])

const clone = <T>(value: T): T => structuredClone(value)
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
const validDate = (value: unknown): value is string => (
  typeof value === 'string'
  && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value
)

const failure = (
  code: ReconcileTaskCoordinationErrorCode,
  message: string,
): Extract<ReconcileTaskCoordinationOutcome, { ok: false }> => ({ ok: false, code, message })

const errorMessage = (record: TaskCoordinationRecord, fallback: string) => (
  record.error?.message
  || record.latestSnapshot?.error?.message
  || fallback
)

const normalizedResult = (result: TaskExecutionResult): TaskExecutionResult => ({
  ...clone(result),
  outputText: result.outputText?.trim() || result.summary.trim(),
})

const validateResultForTask = (
  result: TaskExecutionResult,
  taskId: string,
  providerId: TaskCoordinationRecord['providerId'],
  acceptanceChecks: string[],
) => (
  result.taskId === taskId
  && result.providerId === providerId
  && result.summary.trim().length > 0
  && result.verification.length === acceptanceChecks.length
  && result.verification.every((item, index) => item.label === acceptanceChecks[index])
)

const validateEffects = (
  effects: TaskCoordinationEffect[] | undefined,
  state: TaskCoordinationStateV1,
  latestByTask: Map<string, TaskCoordinationRecord>,
  notices: TaskCoordinationNotice[],
): ReconcileTaskCoordinationOutcome | null => {
  if (effects === undefined) return null
  if (!Array.isArray(effects)) return failure('INVALID_INPUT', '协调效果必须是数组。')

  for (const raw of effects as unknown[]) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return failure('INVALID_INPUT', '协调效果结构无效。')
    }
    const effect = raw as Record<string, unknown>
    if (Object.keys(effect).some(key => !EFFECT_KEYS.has(key))
      || !EFFECT_TYPES.has(String(effect.type))
      || typeof effect.taskId !== 'string'
      || typeof effect.providerId !== 'string'
      || !Number.isInteger(effect.attempt)
      || typeof effect.dispatchId !== 'string'
      || !validDate(effect.occurredAt)) {
      return failure('INVALID_INPUT', '协调效果未通过严格校验。')
    }
    const matching = state.records.find(record => (
      record.taskId === effect.taskId
      && record.providerId === effect.providerId
      && record.attempt === effect.attempt
      && record.dispatchId === effect.dispatchId
    ))
    if (!matching) return failure('STATE_MISMATCH', '协调效果与持久化协调记录不匹配。')
    if (matching.resolution || latestByTask.get(matching.taskId)?.dispatchId !== matching.dispatchId) {
      notices.push({
        taskId: matching.taskId,
        dispatchId: matching.dispatchId,
        level: 'warning',
        code: 'STALE_EFFECT',
        message: '已忽略旧尝试产生的迟到协调效果。',
      })
      continue
    }
    if (effect.reference !== undefined) {
      const checked = validateExecutionReference(effect.reference, {
        taskId: matching.taskId,
        dispatchId: matching.dispatchId,
      })
      if (!checked.ok || !matching.reference || !same(checked.value, matching.reference)) {
        return failure('STATE_MISMATCH', '协调效果包含不匹配的执行引用。')
      }
    }
    if (effect.snapshot !== undefined) {
      const checked = validateExecutionSnapshot(effect.snapshot, {
        taskId: matching.taskId,
        dispatchId: matching.dispatchId,
        providerId: matching.providerId,
      })
      if (!checked.ok || !matching.latestSnapshot || !same(checked.value, matching.latestSnapshot)) {
        return failure('STATE_MISMATCH', '协调效果包含不匹配的执行快照。')
      }
    }
    if (effect.error !== undefined) {
      const expectedError: ExecutionAdapterError | undefined = matching.error ?? matching.latestSnapshot?.error
      if (!expectedError || !same(effect.error, expectedError)) {
        return failure('STATE_MISMATCH', '协调效果包含不匹配的安全错误。')
      }
    }
  }
  return null
}

const update = (
  session: TaskSessionV1,
  action: Parameters<typeof updateTaskSession>[1],
  at: string,
): TaskSessionV1 | Extract<ReconcileTaskCoordinationOutcome, { ok: false }> => {
  const result = updateTaskSession(session, action, at)
  return result.ok
    ? result.session
    : failure(
        result.code === 'INVALID_DATA' ? 'INVALID_RESULT' : 'STATE_MISMATCH',
        result.message,
      )
}

const isFailure = (
  value: TaskSessionV1 | Extract<ReconcileTaskCoordinationOutcome, { ok: false }>,
): value is Extract<ReconcileTaskCoordinationOutcome, { ok: false }> => 'ok' in value && value.ok === false

export function reconcileTaskSessionWithCoordination(
  input: ReconcileTaskCoordinationInput,
): ReconcileTaskCoordinationOutcome {
  const checkedSession = validateTaskSession(input.session)
  if (!checkedSession.ok) return failure('INVALID_INPUT', '任务会话未通过严格校验。')
  const checkedState = validateTaskCoordinationState(input.coordinationState, {
    sessionId: checkedSession.session.id,
    planId: checkedSession.session.plan.id,
    taskIds: checkedSession.session.plan.tasks.map(task => task.id),
  })
  if (!checkedState.ok) return failure('STATE_MISMATCH', '协调状态损坏或与任务会话不匹配。')

  const original = checkedSession.session
  let session = clone(original)
  const notices: TaskCoordinationNotice[] = []
  const latestByTask = new Map<string, TaskCoordinationRecord>()
  for (const record of checkedState.value.records) {
    const current = latestByTask.get(record.taskId)
    if (!current || record.attempt > current.attempt
      || (record.attempt === current.attempt && record.updatedAt > current.updatedAt)) {
      latestByTask.set(record.taskId, record)
    }
  }

  const effectFailure = validateEffects(input.effects, checkedState.value, latestByTask, notices)
  if (effectFailure) return effectFailure

  for (const task of session.plan.tasks) {
    const record = latestByTask.get(task.id)
    if (!record) continue
    let run = session.runs.find(candidate => candidate.taskId === task.id)
    if (!run) return failure('STATE_MISMATCH', '协调记录引用了不存在的任务运行记录。')

    if (record.resolution) {
      if (record.attempt < run.attempt) continue
      if (record.providerId !== run.assignedProviderId || record.attempt > run.attempt + 1) {
        return failure('STATE_MISMATCH', '人工处理记录与当前任务不匹配。')
      }
      const resolved = record.resolution.action === 'manual-takeover'
        ? run.attempt === record.attempt && run.executionMode === 'manual'
        : run.attempt === record.attempt && run.status === 'ready' && run.executionMode === task.executionMode
      if (!resolved) {
        const applied = update(session, {
          type: 'coordination-resolve',
          taskId: task.id,
          providerId: record.providerId,
          attempt: record.attempt,
          action: record.resolution.action,
        }, record.resolution.confirmedAt)
        if (isFailure(applied)) return applied
        session = applied
      }
      continue
    }

    if (record.attempt < run.attempt || (record.attempt === run.attempt && run.status === 'ready')) {
      notices.push({
        taskId: task.id,
        dispatchId: record.dispatchId,
        level: 'warning',
        code: 'STALE_EFFECT',
        message: '协调记录属于已结束的旧尝试，未改变当前任务。',
      })
      continue
    }
    // A reviewed coordinated result can be returned to the human workflow.
    // The old completed snapshot must never overwrite that new draft.
    if (record.attempt === run.attempt && run.executionMode === 'manual'
      && ['running', 'needs-input'].includes(run.status)) continue
    if (record.attempt > run.attempt + 1) {
      return failure('STATE_MISMATCH', '协调尝试次数跳跃，拒绝推进任务会话。')
    }
    if (record.providerId !== run.assignedProviderId) {
      return failure('STATE_MISMATCH', '协调记录 Provider 与当前任务分配不一致。')
    }
    if (record.phase === 'dispatching' || !record.reference) {
      notices.push({
        taskId: task.id,
        dispatchId: record.dispatchId,
        level: record.phase === 'dispatching' && !record.error ? 'info' : record.phase === 'unknown' ? 'error' : 'warning',
        code: record.phase === 'unknown' ? 'MANUAL_REVIEW_REQUIRED' : 'PRE_DISPATCH_BLOCKED',
        message: errorMessage(record, '执行尚未取得可靠收据，任务保持未开始并等待人工处理。'),
      })
      continue
    }

    const terminal = ['review', 'done', 'failed', 'cancelled'].includes(run.status)
    if (terminal) {
      if (['failed', 'cancelled'].includes(run.status) && record.phase === 'completed'
        && record.attempt === run.attempt && run.executionMode !== 'manual') {
        const result = record.latestSnapshot?.result
        if (!result || !validateResultForTask(result, task.id, record.providerId, task.acceptanceChecks)) {
          return failure('INVALID_RESULT', '协调执行结果与任务验收标准不一致。')
        }
        const completed = update(session, {
          type: 'coordination-complete', taskId: task.id, providerId: record.providerId,
          attempt: record.attempt, result: normalizedResult(result),
        }, record.updatedAt)
        if (isFailure(completed)) return completed
        session = completed
        continue
      }
      if (record.phase === 'completed' && ['review', 'done'].includes(run.status) && run.result) {
        const result = record.latestSnapshot?.result
        if (!result || !same(normalizedResult(result), run.result)) {
          notices.push({
            taskId: task.id,
            dispatchId: record.dispatchId,
            level: 'error',
            code: 'RESULT_MISMATCH',
            message: '迟到的完成结果与当前已保存结果不一致，未覆盖现有数据。',
          })
        }
      }
      continue
    }

    if (run.status === 'waiting') {
      return failure('STATE_MISMATCH', '依赖未完成的任务不能接收协调执行状态。')
    }
    if (run.status === 'ready') {
      const started = update(session, {
        type: 'coordination-start',
        taskId: task.id,
        providerId: record.providerId,
        attempt: record.attempt,
        executionMode: task.executionMode as 'api' | 'local-agent',
        message: record.phase === 'queued' ? '任务已派发，正在等待执行适配器启动。' : undefined,
      }, record.createdAt)
      if (isFailure(started)) return started
      session = started
      run = session.runs.find(candidate => candidate.taskId === task.id)!
    }

    if (record.phase === 'queued') continue
    if (record.phase === 'running') {
      if (run.status === 'needs-input') {
        const resumed = update(session, {
          type: 'coordination-resume',
          taskId: task.id,
          providerId: record.providerId,
          attempt: record.attempt,
        }, record.updatedAt)
        if (isFailure(resumed)) return resumed
        session = resumed
      }
      continue
    }
    if (record.phase === 'needs-input') {
      if (run.status === 'running') {
        const waiting = update(session, {
          type: 'coordination-needs-input',
          taskId: task.id,
          providerId: record.providerId,
          attempt: record.attempt,
          message: errorMessage(record, '执行适配器需要补充信息。'),
        }, record.updatedAt)
        if (isFailure(waiting)) return waiting
        session = waiting
      }
      continue
    }
    if (record.phase === 'completed') {
      const result = record.latestSnapshot?.result
      if (!result || !validateResultForTask(result, task.id, record.providerId, task.acceptanceChecks)) {
        return failure('INVALID_RESULT', '协调执行结果与任务验收标准不一致。')
      }
      const completed = update(session, {
        type: 'coordination-complete',
        taskId: task.id,
        providerId: record.providerId,
        attempt: record.attempt,
        result: normalizedResult(result),
      }, record.updatedAt)
      if (isFailure(completed)) return completed
      session = completed
      continue
    }
    if (record.phase === 'failed') {
      const failed = update(session, {
        type: 'coordination-fail',
        taskId: task.id,
        providerId: record.providerId,
        attempt: record.attempt,
        message: errorMessage(record, '执行适配器报告任务失败。'),
      }, record.updatedAt)
      if (isFailure(failed)) return failed
      session = failed
      continue
    }
    if (record.phase === 'cancelled') {
      const cancelled = update(session, {
        type: 'coordination-cancel',
        taskId: task.id,
        providerId: record.providerId,
        attempt: record.attempt,
        message: errorMessage(record, '执行适配器报告任务已取消。'),
      }, record.updatedAt)
      if (isFailure(cancelled)) return cancelled
      session = cancelled
      continue
    }
    if (record.phase === 'unknown') {
      if (run.status === 'running') {
        const unknown = update(session, {
          type: 'coordination-needs-input',
          taskId: task.id,
          providerId: record.providerId,
          attempt: record.attempt,
          message: errorMessage(record, '执行状态未知，需要人工核对，禁止自动重派。'),
        }, record.updatedAt)
        if (isFailure(unknown)) return unknown
        session = unknown
      }
      notices.push({
        taskId: task.id,
        dispatchId: record.dispatchId,
        level: 'error',
        code: 'MANUAL_REVIEW_REQUIRED',
        message: '执行状态未知，需要人工核对，禁止自动重派。',
      })
    }
  }

  const validation = validateTaskSession(session)
  if (!validation.ok) return failure('INVALID_RESULT', '协调后的任务会话未通过严格校验。')
  return {
    ok: true,
    session: validation.session,
    changed: !same(original, validation.session),
    notices,
  }
}

export async function reconcileAndSaveTaskSessionWithCoordination(
  input: ReconcileTaskCoordinationInput & { store: TaskSessionStore },
): Promise<PersistTaskCoordinationOutcome> {
  const reconciled = reconcileTaskSessionWithCoordination(input)
  if (!reconciled.ok || !reconciled.changed) return reconciled
  const saved = await input.store.save(reconciled.session)
  if (!saved.ok) {
    return {
      ok: false,
      code: 'STORAGE_FAILED',
      message: saved.message,
      session: clone(input.session),
    }
  }
  return reconciled
}
