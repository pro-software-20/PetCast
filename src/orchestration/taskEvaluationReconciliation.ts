import type {
  AcceptanceDecision,
  AcceptancePolicy,
  EvaluationReport,
  TaskAcceptanceStateV1,
  TaskCoordinationRecord,
  TaskCoordinationStateV1,
} from '../types/taskCoordination'
import type { TaskSessionV1 } from '../types/taskOrchestration'
import { decideTaskAcceptance } from './taskAcceptancePolicy'
import {
  validateAcceptanceDecision,
  validateAcceptancePolicy,
  validateEvaluationReport,
} from './taskCoordinationValidation'
import { validateTaskCoordinationState } from './taskCoordinationStateValidation'
import { validateTaskAcceptanceState } from './taskEvaluationValidation'
import { validateTaskSession } from './taskSessionValidation'

export interface ReconcileTaskEvaluationInput {
  session: TaskSessionV1
  coordinationState: TaskCoordinationStateV1
  acceptanceState?: TaskAcceptanceStateV1 | null
  report: EvaluationReport
  policy: AcceptancePolicy
}

export type ReconcileTaskEvaluationOutcome =
  | {
      ok: true
      state: TaskAcceptanceStateV1
      decision: AcceptanceDecision
      changed: boolean
    }
  | {
      ok: false
      code: 'INVALID_INPUT' | 'STATE_MISMATCH' | 'INVALID_REPORT' | 'REPORT_CONFLICT'
      message: string
    }

const stable = (value: unknown) => JSON.stringify(value)
const clone = <T>(value: T): T => structuredClone(value)

const latestRecord = (
  records: TaskCoordinationRecord[],
  taskId: string,
): TaskCoordinationRecord | undefined => records
  .filter(record => record.taskId === taskId)
  .sort((left, right) => right.attempt - left.attempt
    || right.updatedAt.localeCompare(left.updatedAt))[0]

const fail = (
  code: Extract<ReconcileTaskEvaluationOutcome, { ok: false }>['code'],
  message: string,
): ReconcileTaskEvaluationOutcome => ({ ok: false, code, message })

/**
 * Accepts a D report and persists B's suggested decision without mutating the
 * task session or triggering another execution.
 */
export function reconcileTaskEvaluation(
  input: ReconcileTaskEvaluationInput,
): ReconcileTaskEvaluationOutcome {
  const checkedSession = validateTaskSession(input.session)
  const checkedPolicy = validateAcceptancePolicy(input.policy)
  if (!checkedSession.ok || !checkedPolicy.ok) {
    return fail('INVALID_INPUT', '任务会话或验收策略未通过严格校验。')
  }
  const session = checkedSession.session
  const coordination = validateTaskCoordinationState(input.coordinationState, {
    sessionId: session.id,
    planId: session.plan.id,
    taskIds: session.plan.tasks.map(task => task.id),
  })
  if (!coordination.ok) return fail('STATE_MISMATCH', '协调状态与当前任务会话不匹配。')

  const report = validateEvaluationReport(input.report, {
    taskId: input.report?.taskId,
    dispatchId: input.report?.dispatchId,
  })
  if (!report.ok) return fail('INVALID_REPORT', '评价报告未通过严格校验。')

  const task = session.plan.tasks.find(item => item.id === report.value.taskId)
  const run = session.runs.find(item => item.taskId === report.value.taskId)
  if (!task || !run || run.status !== 'review' || !run.result) {
    return fail('STATE_MISMATCH', '只有当前处于待验收状态的已完成任务可以接收评价。')
  }
  const record = latestRecord(coordination.value.records, task.id)
  if (!record
    || record.phase !== 'completed'
    || !record.reference
    || record.dispatchId !== report.value.dispatchId
    || record.taskId !== task.id
    || record.attempt !== run.attempt
    || record.providerId !== run.assignedProviderId
    || record.latestSnapshot?.state !== 'completed'
    || record.latestSnapshot.result?.taskId !== task.id
    || record.latestSnapshot.result.providerId !== run.assignedProviderId) {
    return fail('STATE_MISMATCH', '评价报告不是当前任务最新派发和尝试的结果。')
  }
  if (report.value.verification.length !== task.acceptanceChecks.length
    || report.value.verification.some((check, index) => check.label !== task.acceptanceChecks[index])) {
    return fail('INVALID_REPORT', '评价验证项必须与当前任务验收标准逐项对应。')
  }

  const state = input.acceptanceState ?? {
    schemaVersion: 1 as const,
    sessionId: session.id,
    planId: session.plan.id,
    updatedAt: report.value.createdAt,
    records: [],
  }
  const checkedState = validateTaskAcceptanceState(state, {
    sessionId: session.id,
    planId: session.plan.id,
    taskIds: session.plan.tasks.map(item => item.id),
  })
  if (!checkedState.ok) return fail('STATE_MISMATCH', '验收状态损坏或与当前任务会话不匹配。')

  const sameId = checkedState.value.records.find(item => item.evaluationId === report.value.evaluationId)
  if (sameId) {
    if (stable(sameId.report) !== stable(report.value)) {
      return fail('REPORT_CONFLICT', '相同评价 ID 对应了不同报告。')
    }
    if (!sameId.decision) return fail('STATE_MISMATCH', '已有评价记录缺少验收决策。')
    return { ok: true, state: clone(checkedState.value), decision: clone(sameId.decision), changed: false }
  }
  const sameDispatch = checkedState.value.records.find(item => (
    item.taskId === task.id
    && item.dispatchId === record.dispatchId
    && item.attempt === record.attempt
  ))
  if (sameDispatch) return fail('REPORT_CONFLICT', '当前派发和尝试已经存在另一份评价报告。')

  const decision = decideTaskAcceptance({
    report: report.value,
    policy: checkedPolicy.value,
    attempt: record.attempt,
  })
  const checkedDecision = validateAcceptanceDecision(decision, {
    taskId: task.id,
    dispatchId: record.dispatchId,
  })
  if (!checkedDecision.ok) return fail('INVALID_REPORT', 'B 侧验收决策未通过严格校验。')

  const next: TaskAcceptanceStateV1 = {
    ...clone(checkedState.value),
    updatedAt: report.value.createdAt > checkedState.value.updatedAt
      ? report.value.createdAt
      : checkedState.value.updatedAt,
    records: [...clone(checkedState.value.records), {
      evaluationId: report.value.evaluationId,
      taskId: task.id,
      dispatchId: record.dispatchId,
      attempt: record.attempt,
      report: clone(report.value),
      status: 'decided',
      decision: clone(checkedDecision.value),
      receivedAt: report.value.createdAt,
    }],
  }
  const validated = validateTaskAcceptanceState(next, {
    sessionId: session.id,
    planId: session.plan.id,
    taskIds: session.plan.tasks.map(item => item.id),
  })
  return validated.ok
    ? { ok: true, state: validated.value, decision: checkedDecision.value, changed: true }
    : fail('INVALID_REPORT', '验收决策无法安全写入持久化状态。')
}
