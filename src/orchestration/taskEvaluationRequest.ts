import type {
  EvaluationEvidenceRef,
  TaskCoordinationRecord,
  TaskCoordinationStateV1,
  TaskEvaluationRequest,
} from '../types/taskCoordination'
import type { TaskSessionV1 } from '../types/taskOrchestration'
import { validateTaskCoordinationState } from './taskCoordinationStateValidation'
import { validateTaskEvaluationRequest } from './taskEvaluationValidation'
import { validateTaskSession } from './taskSessionValidation'

export interface CreateTaskEvaluationRequestInput {
  session: TaskSessionV1
  coordinationState: TaskCoordinationStateV1
  taskId: string
  evaluationId: string
  evidence?: EvaluationEvidenceRef[]
}

export type CreateTaskEvaluationRequestOutcome =
  | { ok: true; request: TaskEvaluationRequest }
  | { ok: false; code: 'INVALID_INPUT' | 'STATE_MISMATCH'; message: string }

const latestRecord = (records: TaskCoordinationRecord[], taskId: string) => records
  .filter(record => record.taskId === taskId)
  .sort((left, right) => right.attempt - left.attempt
    || right.updatedAt.localeCompare(left.updatedAt))[0]

/** Builds the only payload B is allowed to pass across the D adapter boundary. */
export function createTaskEvaluationRequest(
  input: CreateTaskEvaluationRequestInput,
): CreateTaskEvaluationRequestOutcome {
  const checkedSession = validateTaskSession(input.session)
  if (!checkedSession.ok) return { ok: false, code: 'INVALID_INPUT', message: '任务会话未通过严格校验。' }
  const session = checkedSession.session
  const coordination = validateTaskCoordinationState(input.coordinationState, {
    sessionId: session.id,
    planId: session.plan.id,
    taskIds: session.plan.tasks.map(task => task.id),
  })
  if (!coordination.ok) return { ok: false, code: 'STATE_MISMATCH', message: '协调状态与当前会话不匹配。' }
  const task = session.plan.tasks.find(item => item.id === input.taskId)
  const run = session.runs.find(item => item.taskId === input.taskId)
  const record = latestRecord(coordination.value.records, input.taskId)
  if (!task || !run || run.status !== 'review' || !run.result
    || !record || record.phase !== 'completed' || !record.reference
    || record.attempt !== run.attempt || record.providerId !== run.assignedProviderId
    || record.latestSnapshot?.state !== 'completed') {
    return { ok: false, code: 'STATE_MISMATCH', message: '任务尚无可评价的最新完成结果。' }
  }
  const request: TaskEvaluationRequest = {
    evaluationId: input.evaluationId,
    sessionId: session.id,
    planId: session.plan.id,
    taskId: task.id,
    dispatchId: record.dispatchId,
    attempt: record.attempt,
    providerId: record.providerId,
    task: {
      id: task.id,
      title: task.title,
      description: task.description,
      expectedDeliverables: structuredClone(task.expectedDeliverables),
      acceptanceChecks: structuredClone(task.acceptanceChecks),
    },
    result: {
      summary: run.result.summary,
      verification: structuredClone(run.result.verification),
      changedFiles: structuredClone(run.result.changedFiles),
      evidence: structuredClone(input.evidence ?? []),
    },
  }
  const checked = validateTaskEvaluationRequest(request)
  return checked.ok
    ? { ok: true, request: checked.value }
    : { ok: false, code: 'INVALID_INPUT', message: '评价请求未通过安全边界校验。' }
}
