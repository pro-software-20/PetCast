import {
  EXECUTION_ADAPTER_ERROR_CODES,
  TASK_COORDINATION_PHASES,
  type ExecutionAdapterError,
  type TaskCoordinationStateV1,
} from '../types/taskCoordination'
import { BUILT_IN_PROVIDER_IDS, type ProviderId } from '../types/taskOrchestration'
import {
  type CoordinationValidationIssue,
  type CoordinationValidationResult,
  validateExecutionReference,
  validateExecutionSnapshot,
} from './taskCoordinationValidation'

export const MAX_TASK_COORDINATION_BYTES = 2 * 1024 * 1024
export const MAX_TASK_COORDINATION_RECORDS = 200

export interface TaskCoordinationStateContext {
  sessionId?: string
  planId?: string
  taskIds?: string[]
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$/
const CUSTOM_PROVIDER_ID_PATTERN = /^custom:[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/
const providerIds = new Set<string>(BUILT_IN_PROVIDER_IDS)
const phases = new Set<string>(TASK_COORDINATION_PHASES)
const errorCodes = new Set<string>(EXECUTION_ADAPTER_ERROR_CODES)

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

const issue = (
  issues: CoordinationValidationIssue[],
  code: CoordinationValidationIssue['code'],
  path: string,
  message: string,
) => issues.push({ code, path, message })

const exactKeys = (
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: CoordinationValidationIssue[],
) => {
  const keys = new Set(allowed)
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) issue(issues, 'UNKNOWN_FIELD', `${path}.${key}`, '不允许未知字段。')
  }
}

const validId = (value: unknown) => typeof value === 'string' && ID_PATTERN.test(value)
const validDate = (value: unknown) => (
  typeof value === 'string'
  && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value
)
const validProvider = (value: unknown): value is ProviderId => (
  typeof value === 'string'
  && (providerIds.has(value) || CUSTOM_PROVIDER_ID_PATTERN.test(value))
)

const validateError = (
  value: unknown,
  path: string,
  issues: CoordinationValidationIssue[],
): value is ExecutionAdapterError => {
  if (!isRecord(value)) {
    issue(issues, 'INVALID_SHAPE', path, '执行错误必须是对象。')
    return false
  }
  exactKeys(value, ['code', 'retryable', 'message', 'retryAfterSeconds'], path, issues)
  if (typeof value.code !== 'string' || !errorCodes.has(value.code)) {
    issue(issues, 'INVALID_SHAPE', `${path}.code`, '执行错误码无效。')
  }
  if (typeof value.retryable !== 'boolean') {
    issue(issues, 'INVALID_SHAPE', `${path}.retryable`, 'retryable 必须是布尔值。')
  }
  if (typeof value.message !== 'string' || !value.message.trim() || value.message.length > 500 || value.message.includes('\0')) {
    issue(issues, 'INVALID_SHAPE', `${path}.message`, '错误消息必须是安全的非空文本。')
  }
  if (value.retryAfterSeconds !== undefined
    && (!Number.isInteger(value.retryAfterSeconds) || Number(value.retryAfterSeconds) < 0)) {
    issue(issues, 'INVALID_SHAPE', `${path}.retryAfterSeconds`, '重试等待时间必须是非负整数。')
  }
  return true
}

const prefixIssues = (
  target: CoordinationValidationIssue[],
  prefix: string,
  source: CoordinationValidationIssue[],
) => source.forEach(item => target.push({
  ...item,
  path: item.path === '$' ? prefix : `${prefix}.${item.path.replace(/^\$\.?/, '')}`,
}))

export function validateTaskCoordinationState(
  value: unknown,
  context: TaskCoordinationStateContext = {},
): CoordinationValidationResult<TaskCoordinationStateV1> {
  const issues: CoordinationValidationIssue[] = []
  if (!isRecord(value)) {
    return { ok: false, issues: [{ code: 'INVALID_SHAPE', path: '$', message: '协调状态必须是对象。' }] }
  }
  exactKeys(value, ['schemaVersion', 'sessionId', 'planId', 'updatedAt', 'records'], '$', issues)
  if (value.schemaVersion !== 1) issue(issues, 'INVALID_STATE', 'schemaVersion', '仅支持协调状态版本 1。')
  if (!validId(value.sessionId)) issue(issues, 'INVALID_ID', 'sessionId', '会话 ID 无效。')
  if (!validId(value.planId)) issue(issues, 'INVALID_ID', 'planId', '计划 ID 无效。')
  if (!validDate(value.updatedAt)) issue(issues, 'INVALID_DATE', 'updatedAt', '更新时间必须是 ISO 时间。')
  if (context.sessionId && value.sessionId !== context.sessionId) {
    issue(issues, 'TASK_MISMATCH', 'sessionId', '协调状态与当前会话不匹配。')
  }
  if (context.planId && value.planId !== context.planId) {
    issue(issues, 'TASK_MISMATCH', 'planId', '协调状态与当前计划不匹配。')
  }

  if (!Array.isArray(value.records)) {
    issue(issues, 'INVALID_SHAPE', 'records', '协调记录必须是数组。')
  } else if (value.records.length > MAX_TASK_COORDINATION_RECORDS) {
    issue(issues, 'LIMIT_EXCEEDED', 'records', `协调记录不能超过 ${MAX_TASK_COORDINATION_RECORDS} 条。`)
  } else {
    const dispatchIds = new Set<string>()
    const attempts = new Set<string>()
    const allowedTaskIds = context.taskIds ? new Set(context.taskIds) : undefined
    value.records.forEach((raw, index) => {
      const path = `records[${index}]`
      if (!isRecord(raw)) {
        issue(issues, 'INVALID_SHAPE', path, '协调记录必须是对象。')
        return
      }
      exactKeys(raw, [
        'taskId', 'providerId', 'attempt', 'dispatchId', 'phase', 'reference',
        'latestSnapshot', 'error', 'createdAt', 'updatedAt',
      ], path, issues)
      if (!validId(raw.taskId)) issue(issues, 'INVALID_ID', `${path}.taskId`, '任务 ID 无效。')
      if (allowedTaskIds && typeof raw.taskId === 'string' && !allowedTaskIds.has(raw.taskId)) {
        issue(issues, 'TASK_MISMATCH', `${path}.taskId`, '协调记录引用了当前计划之外的任务。')
      }
      if (!validProvider(raw.providerId)) issue(issues, 'INVALID_PROVIDER_ID', `${path}.providerId`, 'Provider ID 无效。')
      if (!Number.isInteger(raw.attempt) || Number(raw.attempt) < 1) {
        issue(issues, 'INVALID_SHAPE', `${path}.attempt`, '尝试次数必须是正整数。')
      }
      if (!validId(raw.dispatchId)) issue(issues, 'INVALID_ID', `${path}.dispatchId`, '派发 ID 无效。')
      if (typeof raw.dispatchId === 'string') {
        if (dispatchIds.has(raw.dispatchId)) issue(issues, 'INVALID_STATE', `${path}.dispatchId`, '派发 ID 不能重复。')
        dispatchIds.add(raw.dispatchId)
      }
      if (typeof raw.taskId === 'string' && Number.isInteger(raw.attempt)) {
        const key = `${raw.taskId}:${raw.attempt}`
        if (attempts.has(key)) issue(issues, 'INVALID_STATE', path, '同一任务和尝试次数只能有一条协调记录。')
        attempts.add(key)
      }
      if (typeof raw.phase !== 'string' || !phases.has(raw.phase)) {
        issue(issues, 'INVALID_STATE', `${path}.phase`, '协调阶段无效。')
      }
      if (!validDate(raw.createdAt)) issue(issues, 'INVALID_DATE', `${path}.createdAt`, '创建时间必须是 ISO 时间。')
      if (!validDate(raw.updatedAt)) issue(issues, 'INVALID_DATE', `${path}.updatedAt`, '更新时间必须是 ISO 时间。')

      const ctx = {
        taskId: typeof raw.taskId === 'string' ? raw.taskId : undefined,
        dispatchId: typeof raw.dispatchId === 'string' ? raw.dispatchId : undefined,
        providerId: validProvider(raw.providerId) ? raw.providerId : undefined,
      }
      if (raw.reference !== undefined) {
        const checked = validateExecutionReference(raw.reference, ctx)
        if (!checked.ok) prefixIssues(issues, `${path}.reference`, checked.issues)
      }
      if (raw.latestSnapshot !== undefined) {
        const checked = validateExecutionSnapshot(raw.latestSnapshot, ctx)
        if (!checked.ok) prefixIssues(issues, `${path}.latestSnapshot`, checked.issues)
        if (isRecord(raw.latestSnapshot) && raw.latestSnapshot.state !== raw.phase) {
          issue(issues, 'INVALID_STATE', `${path}.latestSnapshot.state`, '快照状态必须与协调阶段一致。')
        }
        if (raw.reference === undefined) {
          issue(issues, 'INVALID_STATE', `${path}.reference`, '保存快照时必须同时保存执行引用。')
        }
      }
      if (raw.error !== undefined) validateError(raw.error, `${path}.error`, issues)
      if (raw.phase === 'dispatching' && (raw.reference !== undefined || raw.latestSnapshot !== undefined || raw.error !== undefined)) {
        issue(issues, 'INVALID_STATE', path, '派发准备阶段不能伪造执行引用、快照或错误。')
      }
      if (['queued', 'running', 'completed'].includes(String(raw.phase)) && raw.reference === undefined) {
        issue(issues, 'INVALID_STATE', `${path}.reference`, '该协调阶段必须包含执行引用。')
      }
      if (['failed', 'unknown'].includes(String(raw.phase)) && raw.error === undefined
        && !(isRecord(raw.latestSnapshot) && raw.latestSnapshot.error !== undefined)) {
        issue(issues, 'INVALID_STATE', `${path}.error`, '失败或未知状态必须包含安全错误。')
      }
      if (['dispatching', 'queued', 'running', 'completed'].includes(String(raw.phase)) && raw.error !== undefined) {
        issue(issues, 'INVALID_STATE', `${path}.error`, '当前阶段不能包含独立错误。')
      }
    })
  }

  try {
    if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_TASK_COORDINATION_BYTES) {
      issue(issues, 'LIMIT_EXCEEDED', '$', '协调状态不能超过 2 MiB。')
    }
  } catch {
    issue(issues, 'INVALID_SHAPE', '$', '协调状态无法序列化。')
  }

  return issues.length === 0
    ? { ok: true, value: value as unknown as TaskCoordinationStateV1 }
    : { ok: false, issues }
}
