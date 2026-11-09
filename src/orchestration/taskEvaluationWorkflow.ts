import type {
  AcceptanceDecision,
  AcceptancePolicy,
  TaskAcceptanceRecord,
  TaskAcceptanceStateV1,
  TaskEvaluationAdapter,
} from '../types/taskCoordination'
import type { TaskSessionV1 } from '../types/taskOrchestration'
import type { TaskAcceptanceStore } from './TaskAcceptanceStore'
import type { TaskCoordinationStore } from './TaskCoordinationStore'
import { reconcileTaskEvaluation } from './taskEvaluationReconciliation'
import { createTaskEvaluationRequest } from './taskEvaluationRequest'

export type TaskEvaluationWorkflowErrorCode =
  | 'ADAPTER_UNAVAILABLE'
  | 'INVALID_INPUT'
  | 'STATE_MISMATCH'
  | 'CANCELLED'
  | 'EVALUATION_FAILED'
  | 'INVALID_REPORT'
  | 'STORAGE_FAILED'

export type TaskEvaluationWorkflowOutcome =
  | {
      ok: true
      state: TaskAcceptanceStateV1
      record: TaskAcceptanceRecord
      decision: AcceptanceDecision
      reused: boolean
    }
  | {
      ok: false
      code: TaskEvaluationWorkflowErrorCode
      message: string
    }

export interface RequestTaskEvaluationInput {
  session: TaskSessionV1
  taskId: string
  adapter?: TaskEvaluationAdapter
  coordinationStore: TaskCoordinationStore
  acceptanceStore: TaskAcceptanceStore
  policy: AcceptancePolicy
  signal: AbortSignal
}

const fail = (
  code: TaskEvaluationWorkflowErrorCode,
  message: string,
): TaskEvaluationWorkflowOutcome => ({ ok: false, code, message })

const latestRecord = (state: Awaited<ReturnType<TaskCoordinationStore['load']>>, taskId: string) => {
  if (!state.ok || !state.state) return undefined
  return [...state.state.records]
    .filter(record => record.taskId === taskId)
    .sort((left, right) => right.attempt - left.attempt
      || right.updatedAt.localeCompare(left.updatedAt))[0]
}

const hashText = (value: string) => {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** Stable and validation-safe identifier for one dispatch attempt. */
export function createStableTaskEvaluationId(dispatchId: string, attempt: number): string {
  const candidate = `evaluation:${dispatchId}:${attempt}`
  return candidate.length <= 160
    ? candidate
    : `evaluation:${dispatchId.slice(0, 138)}:${hashText(candidate)}:${attempt}`
}

const isAbort = (error: unknown, signal: AbortSignal) => signal.aborted
  || (error instanceof DOMException && error.name === 'AbortError')

/**
 * Runs the D evaluation boundary once. The persisted acceptance state is the
 * source of truth: an existing record is reused and never invokes D twice.
 */
export async function requestTaskEvaluation(
  input: RequestTaskEvaluationInput,
): Promise<TaskEvaluationWorkflowOutcome> {
  if (!input.adapter) {
    return fail('ADAPTER_UNAVAILABLE', 'D 评价适配器尚未接入，可继续使用人工验收。')
  }
  if (input.signal.aborted) return fail('CANCELLED', '评价请求已取消。')

  const context = {
    sessionId: input.session.id,
    planId: input.session.plan.id,
    taskIds: input.session.plan.tasks.map(task => task.id),
  }
  const coordination = await input.coordinationStore.load(context)
  if (!coordination.ok || !coordination.state) {
    return fail(
      'STATE_MISMATCH',
      coordination.ok ? '当前任务没有可评价的统一协调执行记录。' : '协调记录无法安全读取，请先核对协调状态。',
    )
  }
  const execution = latestRecord(coordination, input.taskId)
  if (!execution || execution.phase !== 'completed' || !execution.reference) {
    return fail('STATE_MISMATCH', '当前任务没有可评价的最新统一协调执行结果。')
  }
  const evaluationId = createStableTaskEvaluationId(execution.dispatchId, execution.attempt)

  const loaded = await input.acceptanceStore.load(context)
  if (!loaded.ok) return fail('STORAGE_FAILED', '评价记录损坏或无法读取，原数据未被覆盖。')
  const existing = loaded.state?.records.find(record => record.evaluationId === evaluationId)
  if (existing) {
    if (existing.taskId !== input.taskId
      || existing.dispatchId !== execution.dispatchId
      || existing.attempt !== execution.attempt
      || !existing.decision) {
      return fail('STATE_MISMATCH', '已保存评价与当前派发不匹配，不能重复使用。')
    }
    return {
      ok: true,
      state: structuredClone(loaded.state!),
      record: structuredClone(existing),
      decision: structuredClone(existing.decision),
      reused: true,
    }
  }

  const built = createTaskEvaluationRequest({
    session: input.session,
    coordinationState: coordination.state,
    taskId: input.taskId,
    evaluationId,
  })
  if (!built.ok) return fail(built.code, built.message)

  let report
  try {
    report = await input.adapter.evaluate(built.request, input.signal)
  } catch (error) {
    return isAbort(error, input.signal)
      ? fail('CANCELLED', '评价请求已取消。')
      : fail('EVALUATION_FAILED', 'D 评价执行失败，未保存任何评价结果。')
  }
  if (input.signal.aborted) return fail('CANCELLED', '评价请求已取消。')

  const reconciled = reconcileTaskEvaluation({
    session: input.session,
    coordinationState: coordination.state,
    acceptanceState: loaded.state,
    report,
    policy: input.policy,
  })
  if (!reconciled.ok) {
    return fail(
      reconciled.code === 'INVALID_INPUT' ? 'INVALID_INPUT'
        : reconciled.code === 'INVALID_REPORT' || reconciled.code === 'REPORT_CONFLICT'
          ? 'INVALID_REPORT'
          : 'STATE_MISMATCH',
      reconciled.message,
    )
  }
  const saved = await input.acceptanceStore.save(reconciled.state)
  if (!saved.ok) {
    return fail('STORAGE_FAILED', '评价结果未能安全保存，因此不会提供可执行的建议按钮。')
  }
  const record = reconciled.state.records.find(item => item.evaluationId === evaluationId)
  if (!record) return fail('INVALID_REPORT', '评价结果保存后缺少对应记录。')
  return {
    ok: true,
    state: reconciled.state,
    record,
    decision: reconciled.decision,
    reused: !reconciled.changed,
  }
}
