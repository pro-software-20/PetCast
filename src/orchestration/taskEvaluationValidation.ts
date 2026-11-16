import type {
  TaskAcceptanceStateV1,
  TaskEvaluationRequest,
} from '../types/taskCoordination'
import { BUILT_IN_PROVIDER_IDS, type ProviderId } from '../types/taskOrchestration'
import { normalizeWorkspacePath } from './taskPathScope'
import {
  type CoordinationValidationIssue,
  type CoordinationValidationResult,
  validateAcceptanceDecision,
  validateEvaluationReport,
} from './taskCoordinationValidation'

export const MAX_TASK_ACCEPTANCE_BYTES = 2 * 1024 * 1024
export const MAX_TASK_ACCEPTANCE_RECORDS = 200

export interface TaskAcceptanceStateContext {
  sessionId?: string
  planId?: string
  taskIds?: string[]
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$/
const CUSTOM_PROVIDER_ID_PATTERN = /^custom:[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/
const providerIds = new Set<string>(BUILT_IN_PROVIDER_IDS)
const verificationStatuses = new Set(['passed', 'failed', 'not-run'])

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)
const validId = (value: unknown) => typeof value === 'string' && ID_PATTERN.test(value)
const validDate = (value: unknown) => typeof value === 'string'
  && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value
const validProvider = (value: unknown): value is ProviderId => typeof value === 'string'
  && (providerIds.has(value) || CUSTOM_PROVIDER_ID_PATTERN.test(value))
const validText = (value: unknown, max = 12_000, allowEmpty = false) => typeof value === 'string'
  && (allowEmpty || value.trim().length > 0)
  && value.length <= max
  && !value.includes('\0')

const add = (
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
  Object.keys(value).forEach((key) => {
    if (!keys.has(key)) add(issues, 'UNKNOWN_FIELD', `${path}.${key}`, '不允许未知字段。')
  })
}

const prefix = (
  target: CoordinationValidationIssue[],
  path: string,
  source: CoordinationValidationIssue[],
) => source.forEach(item => target.push({
  ...item,
  path: item.path === '$' ? path : `${path}.${item.path.replace(/^\$\.?/, '')}`,
}))

const validateVerification = (
  value: unknown,
  labels: string[],
  path: string,
  issues: CoordinationValidationIssue[],
) => {
  if (!Array.isArray(value) || value.length !== labels.length) {
    add(issues, 'TASK_MISMATCH', path, '验证项必须与任务验收标准逐项对应。')
    return
  }
  value.forEach((entry, index) => {
    const itemPath = `${path}[${index}]`
    if (!isRecord(entry)) {
      add(issues, 'INVALID_SHAPE', itemPath, '验证项必须是对象。')
      return
    }
    exactKeys(entry, ['label', 'status', 'note', 'details'], itemPath, issues)
    if (entry.label !== labels[index]) add(issues, 'TASK_MISMATCH', `${itemPath}.label`, '验证项标签不匹配。')
    if (typeof entry.status !== 'string' || !verificationStatuses.has(entry.status)) {
      add(issues, 'INVALID_STATE', `${itemPath}.status`, '验证状态无效。')
    }
    if (entry.details !== undefined && !validText(entry.details, 2_000, true)) {
      add(issues, 'INVALID_SHAPE', itemPath, '验证说明无效。')
    }
    if (entry.note !== undefined && !validText(entry.note, 2_000, true)) {
      add(issues, 'INVALID_SHAPE', `${itemPath}.note`, '验证备注无效。')
    }
  })
}

export function validateTaskEvaluationRequest(
  value: unknown,
): CoordinationValidationResult<TaskEvaluationRequest> {
  const issues: CoordinationValidationIssue[] = []
  if (!isRecord(value)) {
    return { ok: false, issues: [{ code: 'INVALID_SHAPE', path: '$', message: '评价请求必须是对象。' }] }
  }
  exactKeys(value, [
    'evaluationId', 'sessionId', 'planId', 'taskId', 'dispatchId', 'attempt',
    'providerId', 'task', 'result',
  ], '$', issues)
  for (const key of ['evaluationId', 'sessionId', 'planId', 'taskId', 'dispatchId'] as const) {
    if (!validId(value[key])) add(issues, 'INVALID_ID', key, '必须是安全且非空的标识符。')
  }
  if (!Number.isInteger(value.attempt) || Number(value.attempt) < 1 || Number(value.attempt) > 100) {
    add(issues, 'INVALID_SHAPE', 'attempt', '尝试次数必须是 1 到 100 的整数。')
  }
  if (!validProvider(value.providerId)) add(issues, 'INVALID_PROVIDER_ID', 'providerId', 'Provider ID 无效。')

  let acceptanceChecks: string[] = []
  if (!isRecord(value.task)) {
    add(issues, 'INVALID_SHAPE', 'task', '任务摘要必须是对象。')
  } else {
    exactKeys(value.task, ['id', 'title', 'description', 'expectedDeliverables', 'acceptanceChecks'], 'task', issues)
    if (value.task.id !== value.taskId || !validId(value.task.id)) add(issues, 'TASK_MISMATCH', 'task.id', '任务摘要 ID 不匹配。')
    for (const key of ['title', 'description'] as const) {
      if (!validText(value.task[key])) add(issues, 'INVALID_SHAPE', `task.${key}`, '任务文本无效。')
    }
    for (const key of ['expectedDeliverables', 'acceptanceChecks'] as const) {
      const list = value.task[key]
      if (!Array.isArray(list) || list.length === 0 || list.length > 200
        || list.some(item => !validText(item, 2_000))) {
        add(issues, 'INVALID_SHAPE', `task.${key}`, '任务列表必须包含安全的非空文本。')
      }
    }
    if (Array.isArray(value.task.acceptanceChecks)) {
      acceptanceChecks = value.task.acceptanceChecks.filter(item => typeof item === 'string') as string[]
    }
  }

  if (!isRecord(value.result)) {
    add(issues, 'INVALID_SHAPE', 'result', '执行结果摘要必须是对象。')
  } else {
    exactKeys(value.result, ['summary', 'verification', 'changedFiles', 'evidence'], 'result', issues)
    if (!validText(value.result.summary, 4_000)) add(issues, 'INVALID_SHAPE', 'result.summary', '结果摘要无效。')
    validateVerification(value.result.verification, acceptanceChecks, 'result.verification', issues)
    if (!Array.isArray(value.result.changedFiles) || value.result.changedFiles.length > 200) {
      add(issues, 'INVALID_SHAPE', 'result.changedFiles', '修改文件必须是受限数组。')
    } else {
      value.result.changedFiles.forEach((path, index) => {
        if (typeof path !== 'string' || normalizeWorkspacePath(path) !== path) {
          add(issues, 'INVALID_PATH', `result.changedFiles[${index}]`, '文件必须是安全的工作区相对路径。')
        }
      })
    }
    const evidenceCheck = validateEvaluationReport({
      evaluationId: value.evaluationId,
      dispatchId: value.dispatchId,
      taskId: value.taskId,
      verdict: 'unknown',
      verification: value.result.verification,
      method: 'rubric',
      ruleVersion: 'request-validation',
      comparisonBasis: 'request-validation',
      evidence: value.result.evidence,
      note: '',
      createdAt: '2026-01-01T00:00:00.000Z',
    }, { taskId: typeof value.taskId === 'string' ? value.taskId : undefined, dispatchId: typeof value.dispatchId === 'string' ? value.dispatchId : undefined })
    if (!evidenceCheck.ok) {
      const evidenceIssues = evidenceCheck.issues.filter(item => item.path.startsWith('evidence'))
      prefix(issues, 'result', evidenceIssues)
    }
  }
  return issues.length === 0
    ? { ok: true, value: value as unknown as TaskEvaluationRequest }
    : { ok: false, issues }
}

export function validateTaskAcceptanceState(
  value: unknown,
  context: TaskAcceptanceStateContext = {},
): CoordinationValidationResult<TaskAcceptanceStateV1> {
  const issues: CoordinationValidationIssue[] = []
  if (!isRecord(value)) {
    return { ok: false, issues: [{ code: 'INVALID_SHAPE', path: '$', message: '验收状态必须是对象。' }] }
  }
  exactKeys(value, ['schemaVersion', 'sessionId', 'planId', 'updatedAt', 'records'], '$', issues)
  if (value.schemaVersion !== 1) add(issues, 'INVALID_SHAPE', 'schemaVersion', '仅支持 schemaVersion 1。')
  if (!validId(value.sessionId)) add(issues, 'INVALID_ID', 'sessionId', '会话 ID 无效。')
  if (!validId(value.planId)) add(issues, 'INVALID_ID', 'planId', '计划 ID 无效。')
  if (context.sessionId && value.sessionId !== context.sessionId) add(issues, 'TASK_MISMATCH', 'sessionId', '验收状态与当前会话不匹配。')
  if (context.planId && value.planId !== context.planId) add(issues, 'TASK_MISMATCH', 'planId', '验收状态与当前计划不匹配。')
  if (!validDate(value.updatedAt)) add(issues, 'INVALID_DATE', 'updatedAt', '更新时间必须是 UTC ISO 8601 时间。')
  const taskIds = context.taskIds ? new Set(context.taskIds) : undefined
  const evaluationIds = new Set<string>()
  if (!Array.isArray(value.records) || value.records.length > MAX_TASK_ACCEPTANCE_RECORDS) {
    add(issues, Array.isArray(value.records) ? 'LIMIT_EXCEEDED' : 'INVALID_SHAPE', 'records', '验收记录必须是受限数组。')
  } else {
    value.records.forEach((raw, index) => {
      const path = `records[${index}]`
      if (!isRecord(raw)) {
        add(issues, 'INVALID_SHAPE', path, '验收记录必须是对象。')
        return
      }
      exactKeys(raw, ['evaluationId', 'taskId', 'dispatchId', 'attempt', 'report', 'status', 'decision', 'receivedAt'], path, issues)
      for (const key of ['evaluationId', 'taskId', 'dispatchId'] as const) {
        if (!validId(raw[key])) add(issues, 'INVALID_ID', `${path}.${key}`, '记录标识无效。')
      }
      if (typeof raw.evaluationId === 'string') {
        if (evaluationIds.has(raw.evaluationId)) add(issues, 'INVALID_STATE', `${path}.evaluationId`, '评价 ID 不能重复。')
        evaluationIds.add(raw.evaluationId)
      }
      if (taskIds && typeof raw.taskId === 'string' && !taskIds.has(raw.taskId)) {
        add(issues, 'TASK_MISMATCH', `${path}.taskId`, '验收记录引用了未知任务。')
      }
      if (!Number.isInteger(raw.attempt) || Number(raw.attempt) < 1 || Number(raw.attempt) > 100) {
        add(issues, 'INVALID_SHAPE', `${path}.attempt`, '尝试次数无效。')
      }
      if (!validDate(raw.receivedAt)) add(issues, 'INVALID_DATE', `${path}.receivedAt`, '接收时间无效。')
      if (!['received', 'decided'].includes(String(raw.status))) add(issues, 'INVALID_STATE', `${path}.status`, '处理状态无效。')
      const report = validateEvaluationReport(raw.report, {
        taskId: typeof raw.taskId === 'string' ? raw.taskId : undefined,
        dispatchId: typeof raw.dispatchId === 'string' ? raw.dispatchId : undefined,
      })
      if (!report.ok) prefix(issues, `${path}.report`, report.issues)
      if (isRecord(raw.report) && raw.report.evaluationId !== raw.evaluationId) {
        add(issues, 'TASK_MISMATCH', `${path}.report.evaluationId`, '报告评价 ID 与记录不匹配。')
      }
      if (raw.decision !== undefined) {
        const decision = validateAcceptanceDecision(raw.decision, {
          taskId: typeof raw.taskId === 'string' ? raw.taskId : undefined,
          dispatchId: typeof raw.dispatchId === 'string' ? raw.dispatchId : undefined,
        })
        if (!decision.ok) prefix(issues, `${path}.decision`, decision.issues)
        if (isRecord(raw.decision) && raw.decision.evaluationId !== raw.evaluationId) {
          add(issues, 'TASK_MISMATCH', `${path}.decision.evaluationId`, '决策评价 ID 与记录不匹配。')
        }
      }
      if (raw.status === 'received' && raw.decision !== undefined) add(issues, 'INVALID_STATE', `${path}.decision`, '未决记录不能包含验收决策。')
      if (raw.status === 'decided' && raw.decision === undefined) add(issues, 'INVALID_STATE', `${path}.decision`, '已决记录必须包含验收决策。')
    })
  }
  try {
    if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_TASK_ACCEPTANCE_BYTES) {
      add(issues, 'LIMIT_EXCEEDED', '$', '验收状态不能超过 2 MiB。')
    }
  } catch {
    add(issues, 'INVALID_SHAPE', '$', '验收状态无法序列化。')
  }
  return issues.length === 0
    ? { ok: true, value: value as unknown as TaskAcceptanceStateV1 }
    : { ok: false, issues }
}
