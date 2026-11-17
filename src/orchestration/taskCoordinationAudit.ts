import type {
  TaskCoordinationAuditEvent,
  TaskCoordinationAuditLevel,
  TaskCoordinationAuditStateV1,
} from '../types/taskCoordination'

export const MAX_TASK_COORDINATION_AUDIT_EVENTS = 500
export const MAX_TASK_COORDINATION_AUDIT_BYTES = 512 * 1024

export interface TaskCoordinationAuditContext {
  sessionId: string
  planId: string
  taskIds?: string[]
}

export type TaskCoordinationAuditIssueCode =
  | 'INVALID_SHAPE'
  | 'UNKNOWN_FIELD'
  | 'CONTEXT_MISMATCH'
  | 'LIMIT_EXCEEDED'
  | 'UNSAFE_CONTENT'

export interface TaskCoordinationAuditValidationResult {
  ok: boolean
  value?: TaskCoordinationAuditStateV1
  issues: Array<{ code: TaskCoordinationAuditIssueCode; path: string; message: string }>
}

const eventTypes = new Set([
  'confirmation-requested', 'coordination-started', 'coordination-paused',
  'coordination-resumed', 'inspection-requested', 'dispatch-intended',
  'dispatch-accepted', 'execution-snapshot', 'execution-cancel-requested',
  'execution-cancelled', 'recovery-decision', 'evaluation-requested',
  'evaluation-received', 'acceptance-decision', 'user-decision', 'notice',
])
const levels = new Set<TaskCoordinationAuditLevel>(['info', 'warning', 'error'])
const idPattern = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$/
const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)
const validDate = (value: unknown) => typeof value === 'string'
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
const validId = (value: unknown) => typeof value === 'string' && idPattern.test(value)
const safeText = (value: unknown) => typeof value === 'string'
  && value.trim().length > 0
  && value.length <= 500
  && !value.includes('\0')
  && !/(?:[A-Za-z]:[\\/]|\\\\|\/(?:home|users|etc|var|private)\b)/i.test(value)
  && !/(?:authorization|api[_ -]?key|password|bearer\s+|sk-)[\s:=]/i.test(value)

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const issue = (issues: TaskCoordinationAuditValidationResult['issues'], code: TaskCoordinationAuditIssueCode, path: string, message: string) => {
  issues.push({ code, path, message })
}

export const createEmptyTaskCoordinationAuditState = (
  context: TaskCoordinationAuditContext,
  now = new Date(),
): TaskCoordinationAuditStateV1 => ({
  schemaVersion: 1,
  sessionId: context.sessionId,
  planId: context.planId,
  updatedAt: now.toISOString(),
  events: [],
})

export const validateTaskCoordinationAuditState = (
  value: unknown,
  context?: TaskCoordinationAuditContext,
): TaskCoordinationAuditValidationResult => {
  const issues: TaskCoordinationAuditValidationResult['issues'] = []
  if (!isRecord(value)) return { ok: false, issues: [{ code: 'INVALID_SHAPE', path: '$', message: '审计记录必须是对象。' }] }
  for (const key of Object.keys(value)) {
    if (!['schemaVersion', 'sessionId', 'planId', 'updatedAt', 'events'].includes(key)) issue(issues, 'UNKNOWN_FIELD', `$.${key}`, '不允许未知字段。')
  }
  if (value.schemaVersion !== 1) issue(issues, 'INVALID_SHAPE', '$.schemaVersion', '仅支持审计记录版本 1。')
  if (!validId(value.sessionId)) issue(issues, 'INVALID_SHAPE', '$.sessionId', '会话标识无效。')
  if (!validId(value.planId)) issue(issues, 'INVALID_SHAPE', '$.planId', '计划标识无效。')
  if (!validDate(value.updatedAt)) issue(issues, 'INVALID_SHAPE', '$.updatedAt', '更新时间无效。')
  if (context?.sessionId && value.sessionId !== context.sessionId) issue(issues, 'CONTEXT_MISMATCH', '$.sessionId', '审计记录不属于当前会话。')
  if (context?.planId && value.planId !== context.planId) issue(issues, 'CONTEXT_MISMATCH', '$.planId', '审计记录不属于当前计划。')
  if (!Array.isArray(value.events)) issue(issues, 'INVALID_SHAPE', '$.events', '事件列表无效。')
  const ids = new Set<string>()
  if (Array.isArray(value.events)) {
    if (value.events.length > MAX_TASK_COORDINATION_AUDIT_EVENTS) issue(issues, 'LIMIT_EXCEEDED', '$.events', '事件数量超出上限。')
    value.events.forEach((candidate, index) => {
      const path = `$.events[${index}]`
      if (!isRecord(candidate)) { issue(issues, 'INVALID_SHAPE', path, '事件必须是对象。'); return }
      for (const key of Object.keys(candidate)) {
        if (!['id', 'type', 'level', 'occurredAt', 'summary', 'taskId', 'providerId', 'dispatchId', 'attempt'].includes(key)) issue(issues, 'UNKNOWN_FIELD', `${path}.${key}`, '不允许未知事件字段。')
      }
      if (!validId(candidate.id)) issue(issues, 'INVALID_SHAPE', `${path}.id`, '事件标识无效。')
      else if (ids.has(String(candidate.id))) issue(issues, 'INVALID_SHAPE', `${path}.id`, '事件标识重复。')
      else ids.add(String(candidate.id))
      if (typeof candidate.type !== 'string' || !eventTypes.has(candidate.type)) issue(issues, 'INVALID_SHAPE', `${path}.type`, '事件类型无效。')
      if (typeof candidate.level !== 'string' || !levels.has(candidate.level as TaskCoordinationAuditLevel)) issue(issues, 'INVALID_SHAPE', `${path}.level`, '事件级别无效。')
      if (!validDate(candidate.occurredAt)) issue(issues, 'INVALID_SHAPE', `${path}.occurredAt`, '事件时间无效。')
      if (!safeText(candidate.summary)) issue(issues, 'UNSAFE_CONTENT', `${path}.summary`, '事件摘要必须是脱敏安全文本。')
      for (const field of ['taskId', 'providerId', 'dispatchId'] as const) {
        if (candidate[field] !== undefined && !validId(candidate[field])) issue(issues, 'INVALID_SHAPE', `${path}.${field}`, `${field} 无效。`)
      }
      if (candidate.taskId && context?.taskIds && !context.taskIds.includes(candidate.taskId as string)) issue(issues, 'CONTEXT_MISMATCH', `${path}.taskId`, '事件任务不属于当前计划。')
      if (candidate.attempt !== undefined && (!Number.isInteger(candidate.attempt) || Number(candidate.attempt) < 0)) issue(issues, 'INVALID_SHAPE', `${path}.attempt`, '尝试次数无效。')
    })
  }
  const size = new TextEncoder().encode(JSON.stringify(value)).length
  if (size > MAX_TASK_COORDINATION_AUDIT_BYTES) issue(issues, 'LIMIT_EXCEEDED', '$', '审计记录超过本地容量限制。')
  return issues.length ? { ok: false, issues } : { ok: true, value: clone(value as unknown as TaskCoordinationAuditStateV1), issues: [] }
}

export type TaskCoordinationAuditEventDraft = Omit<TaskCoordinationAuditEvent, 'id' | 'occurredAt'> & {
  id?: string
  occurredAt?: string
}

const hash = (value: string) => {
  let result = 2166136261
  for (const char of value) result = Math.imul(result ^ char.charCodeAt(0), 16777619)
  return (result >>> 0).toString(36)
}

export const createTaskCoordinationAuditEvent = (
  context: TaskCoordinationAuditContext,
  draft: TaskCoordinationAuditEventDraft,
  now = new Date(),
): TaskCoordinationAuditEvent => {
  const occurredAt = draft.occurredAt ?? now.toISOString()
  const id = draft.id ?? `audit:${hash([context.sessionId, context.planId, draft.type, occurredAt, draft.taskId ?? '', draft.dispatchId ?? '', draft.summary].join('|'))}`
  return { ...draft, id, occurredAt }
}

export const appendTaskCoordinationAuditEvent = (
  state: TaskCoordinationAuditStateV1 | null,
  context: TaskCoordinationAuditContext,
  draft: TaskCoordinationAuditEventDraft,
  now = new Date(),
): { ok: true; state: TaskCoordinationAuditStateV1; added: boolean } | { ok: false; message: string } => {
  const base = state ?? createEmptyTaskCoordinationAuditState(context, now)
  const validated = validateTaskCoordinationAuditState(base, context)
  if (!validated.ok || !validated.value) return { ok: false, message: '协调审计记录损坏或不匹配，未覆盖原数据。' }
  const event = createTaskCoordinationAuditEvent(context, draft, now)
  const eventCheck = validateTaskCoordinationAuditState({ ...validated.value, events: [event], updatedAt: event.occurredAt }, context)
  if (!eventCheck.ok) return { ok: false, message: '协调审计事件包含不安全或无效内容。' }
  if (validated.value.events.some(item => item.id === event.id)) return { ok: true, state: validated.value, added: false }
  const next: TaskCoordinationAuditStateV1 = {
    ...validated.value,
    updatedAt: event.occurredAt,
    events: [...validated.value.events, event].slice(-MAX_TASK_COORDINATION_AUDIT_EVENTS),
  }
  const checked = validateTaskCoordinationAuditState(next, context)
  return checked.ok && checked.value
    ? { ok: true, state: checked.value, added: true }
    : { ok: false, message: '协调审计记录超过容量限制。' }
}
