import {
  ACCEPTANCE_DECISION_ACTIONS,
  ACCEPTANCE_DECISION_REASONS,
  EVALUATION_EVIDENCE_TYPES,
  EVALUATION_METHODS,
  EVALUATION_VERDICTS,
  EXECUTION_ADAPTER_ERROR_CODES,
  EXECUTION_ADAPTER_STATES,
  type AcceptanceDecision,
  type AcceptancePolicy,
  type EvaluationReport,
  type ExecutionAdapterError,
  type ExecutionDispatchRequest,
  type ExecutionReceipt,
  type ExecutionReference,
  type ExecutionSnapshot,
} from '../types/taskCoordination'
import {
  BUILT_IN_PROVIDER_IDS,
  type ProviderId,
  type TaskExecutionResult,
  type TaskNode,
  type TaskVerificationResult,
} from '../types/taskOrchestration'
import { normalizeWorkspacePath } from './taskPathScope'
import { validateTaskPlan } from './taskPlanValidation'

export const MAX_COORDINATION_TEXT_LENGTH = 12_000
export const MAX_COORDINATION_ITEMS = 200

export type CoordinationValidationIssueCode =
  | 'INVALID_SHAPE'
  | 'UNKNOWN_FIELD'
  | 'LIMIT_EXCEEDED'
  | 'INVALID_ID'
  | 'INVALID_DATE'
  | 'INVALID_PATH'
  | 'INVALID_PROVIDER_ID'
  | 'INVALID_STATE'
  | 'TASK_MISMATCH'

export interface CoordinationValidationIssue {
  code: CoordinationValidationIssueCode
  path: string
  message: string
}

export type CoordinationValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: CoordinationValidationIssue[] }

export interface CoordinationValidationContext {
  taskId?: string
  dispatchId?: string
  providerId?: ProviderId
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$/
const CUSTOM_PROVIDER_ID_PATTERN = /^custom:[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/
const builtInProviderIds = new Set<string>(BUILT_IN_PROVIDER_IDS)
const executionStates = new Set<string>(EXECUTION_ADAPTER_STATES)
const executionErrorCodes = new Set<string>(EXECUTION_ADAPTER_ERROR_CODES)
const evaluationVerdicts = new Set<string>(EVALUATION_VERDICTS)
const evaluationMethods = new Set<string>(EVALUATION_METHODS)
const evidenceTypes = new Set<string>(EVALUATION_EVIDENCE_TYPES)
const decisionActions = new Set<string>(ACCEPTANCE_DECISION_ACTIONS)
const decisionReasons = new Set<string>(ACCEPTANCE_DECISION_REASONS)
const verificationStatuses = new Set(['passed', 'failed', 'not-run'])

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

const push = (
  issues: CoordinationValidationIssue[],
  code: CoordinationValidationIssueCode,
  path: string,
  message: string,
) => issues.push({ code, path, message })

const validateExactKeys = (
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: CoordinationValidationIssue[],
) => {
  const allowedKeys = new Set(allowed)
  Object.keys(value).forEach((key) => {
    if (!allowedKeys.has(key)) {
      push(issues, 'UNKNOWN_FIELD', path === '$' ? key : `${path}.${key}`, '不允许未知字段。')
    }
  })
}

const validateId = (
  value: unknown,
  path: string,
  issues: CoordinationValidationIssue[],
) => {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    push(issues, 'INVALID_ID', path, '必须是安全且非空的标识符。')
    return false
  }
  return true
}

const validateText = (
  value: unknown,
  path: string,
  issues: CoordinationValidationIssue[],
  options: { allowEmpty?: boolean; max?: number } = {},
) => {
  const max = options.max ?? MAX_COORDINATION_TEXT_LENGTH
  if (typeof value !== 'string'
    || (!options.allowEmpty && value.trim().length === 0)
    || value.length > max
    || value.includes('\0')) {
    push(issues, value instanceof String || (typeof value === 'string' && value.length > max)
      ? 'LIMIT_EXCEEDED'
      : 'INVALID_SHAPE', path, `必须是长度不超过 ${max} 的安全文本。`)
    return false
  }
  return true
}

const validateIsoDate = (
  value: unknown,
  path: string,
  issues: CoordinationValidationIssue[],
) => {
  if (typeof value !== 'string'
    || Number.isNaN(Date.parse(value))
    || new Date(value).toISOString() !== value) {
    push(issues, 'INVALID_DATE', path, '必须是 UTC ISO 8601 时间。')
    return false
  }
  return true
}

const isProviderId = (value: unknown): value is ProviderId => (
  typeof value === 'string'
  && (builtInProviderIds.has(value) || CUSTOM_PROVIDER_ID_PATTERN.test(value))
)

const validateProviderId = (
  value: unknown,
  path: string,
  issues: CoordinationValidationIssue[],
) => {
  if (!isProviderId(value)) {
    push(issues, 'INVALID_PROVIDER_ID', path, 'Provider ID 不受支持。')
    return false
  }
  return true
}

const validateStringArray = (
  value: unknown,
  path: string,
  issues: CoordinationValidationIssue[],
  options: { requireItem?: boolean; pathValues?: boolean } = {},
) => {
  if (!Array.isArray(value) || value.length > MAX_COORDINATION_ITEMS) {
    push(issues, Array.isArray(value) ? 'LIMIT_EXCEEDED' : 'INVALID_SHAPE', path, '必须是受限数组。')
    return false
  }
  if (options.requireItem && value.length === 0) {
    push(issues, 'INVALID_SHAPE', path, '至少需要一项。')
  }
  const seen = new Set<string>()
  value.forEach((item, index) => {
    const itemPath = `${path}[${index}]`
    if (!validateText(item, itemPath, issues)) return
    const normalized = options.pathValues ? normalizeWorkspacePath(String(item)) : String(item)
    if (options.pathValues && normalized !== item) {
      push(issues, 'INVALID_PATH', itemPath, '必须是安全的工作区相对路径。')
    }
    if (seen.has(String(item))) push(issues, 'INVALID_SHAPE', itemPath, '数组项目不能重复。')
    seen.add(String(item))
  })
  return true
}

const validateVerification = (
  value: unknown,
  path: string,
  issues: CoordinationValidationIssue[],
): value is TaskVerificationResult[] => {
  if (!Array.isArray(value) || value.length > MAX_COORDINATION_ITEMS) {
    push(issues, Array.isArray(value) ? 'LIMIT_EXCEEDED' : 'INVALID_SHAPE', path, '验证结果必须是受限数组。')
    return false
  }
  value.forEach((item, index) => {
    const itemPath = `${path}[${index}]`
    if (!isRecord(item)) {
      push(issues, 'INVALID_SHAPE', itemPath, '验证结果必须是对象。')
      return
    }
    validateExactKeys(item, ['label', 'status', 'details'], itemPath, issues)
    validateText(item.label, `${itemPath}.label`, issues)
    if (typeof item.status !== 'string' || !verificationStatuses.has(item.status)) {
      push(issues, 'INVALID_SHAPE', `${itemPath}.status`, '验证状态无效。')
    }
    if (item.details !== undefined) {
      validateText(item.details, `${itemPath}.details`, issues, { allowEmpty: true })
    }
  })
  return true
}

const validateArtifacts = (
  value: unknown,
  path: string,
  issues: CoordinationValidationIssue[],
) => {
  if (!Array.isArray(value) || value.length > MAX_COORDINATION_ITEMS) {
    push(issues, Array.isArray(value) ? 'LIMIT_EXCEEDED' : 'INVALID_SHAPE', path, '文件元信息必须是受限数组。')
    return
  }
  const paths = new Set<string>()
  value.forEach((item, index) => {
    const itemPath = `${path}[${index}]`
    if (!isRecord(item)) {
      push(issues, 'INVALID_SHAPE', itemPath, '文件元信息必须是对象。')
      return
    }
    validateExactKeys(item, ['path', 'description'], itemPath, issues)
    if (typeof item.path !== 'string' || normalizeWorkspacePath(item.path) !== item.path) {
      push(issues, 'INVALID_PATH', `${itemPath}.path`, '必须是安全的工作区相对路径。')
    } else if (paths.has(item.path)) {
      push(issues, 'INVALID_PATH', `${itemPath}.path`, '文件路径不能重复。')
    } else {
      paths.add(item.path)
    }
    validateText(item.description, `${itemPath}.description`, issues)
  })
}

const TASK_KEYS = [
  'id', 'title', 'description', 'dependsOn', 'recommendedProviderId',
  'providerRecommendation', 'executionMode', 'prompt', 'files',
  'expectedDeliverables', 'acceptanceChecks',
] as const

const validateTaskUnknownFields = (
  task: Record<string, unknown>,
  path: string,
  issues: CoordinationValidationIssue[],
) => {
  validateExactKeys(task, TASK_KEYS, path, issues)
  if (isRecord(task.providerRecommendation)) {
    validateExactKeys(
      task.providerRecommendation,
      ['category', 'requiredCapabilities', 'confidence', 'reason'],
      `${path}.providerRecommendation`,
      issues,
    )
  }
  if (!isRecord(task.files)) return
  validateExactKeys(
    task.files,
    ['inputs', 'readPaths', 'allowedWritePaths', 'forbiddenPaths', 'outputPaths'],
    `${path}.files`,
    issues,
  )
  if (Array.isArray(task.files.inputs)) {
    task.files.inputs.forEach((file, index) => {
      if (!isRecord(file)) return
      validateExactKeys(
        file,
        file.kind === 'attachment' ? ['kind', 'name', 'type', 'size'] : ['kind', 'path'],
        `${path}.files.inputs[${index}]`,
        issues,
      )
    })
  }
}

const validateTaskNode = (
  value: unknown,
  path: string,
  issues: CoordinationValidationIssue[],
): value is TaskNode => {
  if (!isRecord(value)) {
    push(issues, 'INVALID_SHAPE', path, '任务定义必须是对象。')
    return false
  }
  validateTaskUnknownFields(value, path, issues)
  const dependencies = Array.isArray(value.dependsOn)
    ? value.dependsOn.filter((item): item is string => typeof item === 'string')
    : []
  const placeholder = (id: string): TaskNode => ({
    id,
    title: `Dependency ${id}`,
    description: 'Direct dependency placeholder used for validation.',
    dependsOn: [],
    recommendedProviderId: 'local',
    executionMode: 'manual',
    prompt: 'Dependency context is supplied by the handoff package.',
    files: { inputs: [], readPaths: [], allowedWritePaths: [], forbiddenPaths: [], outputPaths: [] },
    expectedDeliverables: ['Dependency result'],
    acceptanceChecks: ['Dependency completed'],
  })
  const result = validateTaskPlan({
    schemaVersion: 1,
    id: 'coordination-validation',
    title: 'Coordination validation',
    goal: 'Validate one dispatched task.',
    assumptions: [],
    tasks: [...new Set(dependencies)].filter(id => id !== value.id).map(placeholder).concat(value as unknown as TaskNode),
    finalAcceptanceChecks: ['Dispatched task is valid.'],
  })
  if (!result.ok) {
    result.issues.forEach(issue => push(
      issues,
      issue.code === 'INVALID_PATH' ? 'INVALID_PATH' : 'INVALID_SHAPE',
      `${path}.${issue.path}`,
      issue.message,
    ))
    return false
  }
  return true
}

const validateDependencyHandoffs = (
  value: unknown,
  task: TaskNode | undefined,
  path: string,
  issues: CoordinationValidationIssue[],
) => {
  if (!Array.isArray(value) || value.length > MAX_COORDINATION_ITEMS) {
    push(issues, Array.isArray(value) ? 'LIMIT_EXCEEDED' : 'INVALID_SHAPE', path, '直接依赖交接必须是受限数组。')
    return
  }
  const ids = new Set<string>()
  value.forEach((item, index) => {
    const itemPath = `${path}[${index}]`
    if (!isRecord(item)) {
      push(issues, 'INVALID_SHAPE', itemPath, '依赖交接必须是对象。')
      return
    }
    validateExactKeys(
      item,
      ['dependencyTaskId', 'summary', 'keyDecisions', 'verification', 'artifacts', 'openQuestions'],
      itemPath,
      issues,
    )
    if (validateId(item.dependencyTaskId, `${itemPath}.dependencyTaskId`, issues)) {
      const dependencyId = String(item.dependencyTaskId)
      if (ids.has(dependencyId)) {
        push(issues, 'TASK_MISMATCH', `${itemPath}.dependencyTaskId`, '直接依赖不能重复。')
      }
      if (task && !task.dependsOn.includes(dependencyId)) {
        push(issues, 'TASK_MISMATCH', `${itemPath}.dependencyTaskId`, '只能携带当前任务的直接依赖。')
      }
      ids.add(dependencyId)
    }
    validateText(item.summary, `${itemPath}.summary`, issues)
    validateStringArray(item.keyDecisions, `${itemPath}.keyDecisions`, issues)
    validateVerification(item.verification, `${itemPath}.verification`, issues)
    validateArtifacts(item.artifacts, `${itemPath}.artifacts`, issues)
    validateStringArray(item.openQuestions, `${itemPath}.openQuestions`, issues)
  })
  if (task) {
    const expected = new Set(task.dependsOn)
    if (ids.size !== expected.size || [...expected].some(id => !ids.has(id))) {
      push(issues, 'TASK_MISMATCH', path, '必须且只能提供所有直接前置任务的交接包。')
    }
  }
}

export function validateExecutionDispatchRequest(
  value: unknown,
): CoordinationValidationResult<ExecutionDispatchRequest> {
  const issues: CoordinationValidationIssue[] = []
  if (!isRecord(value)) {
    return { ok: false, issues: [{ code: 'INVALID_SHAPE', path: '$', message: '执行派发请求必须是对象。' }] }
  }
  validateExactKeys(
    value,
    ['dispatchId', 'sessionId', 'planId', 'taskId', 'attempt', 'providerId', 'task', 'directDependencies'],
    '$',
    issues,
  )
  validateId(value.dispatchId, 'dispatchId', issues)
  validateId(value.sessionId, 'sessionId', issues)
  validateId(value.planId, 'planId', issues)
  validateId(value.taskId, 'taskId', issues)
  validateProviderId(value.providerId, 'providerId', issues)
  if (!Number.isInteger(value.attempt) || Number(value.attempt) < 1) {
    push(issues, 'INVALID_SHAPE', 'attempt', '尝试次数必须是大于零的整数。')
  }
  const taskValid = validateTaskNode(value.task, 'task', issues)
  const task = taskValid ? value.task as TaskNode : undefined
  if (task && task.id !== value.taskId) {
    push(issues, 'TASK_MISMATCH', 'task.id', '任务定义必须与派发任务 ID 一致。')
  }
  validateDependencyHandoffs(value.directDependencies, task, 'directDependencies', issues)
  return issues.length === 0
    ? { ok: true, value: value as unknown as ExecutionDispatchRequest }
    : { ok: false, issues }
}

const validateExecutionReferenceFields = (
  value: Record<string, unknown>,
  path: string,
  issues: CoordinationValidationIssue[],
  context: CoordinationValidationContext,
) => {
  validateId(value.dispatchId, `${path}.dispatchId`.replace(/^\$\./, ''), issues)
  validateId(value.adapterExecutionId, `${path}.adapterExecutionId`.replace(/^\$\./, ''), issues)
  validateId(value.taskId, `${path}.taskId`.replace(/^\$\./, ''), issues)
  if (context.dispatchId && value.dispatchId !== context.dispatchId) {
    push(issues, 'TASK_MISMATCH', 'dispatchId', '派发 ID 与预期不一致。')
  }
  if (context.taskId && value.taskId !== context.taskId) {
    push(issues, 'TASK_MISMATCH', 'taskId', '任务 ID 与预期不一致。')
  }
}

export function validateExecutionReference(
  value: unknown,
  context: CoordinationValidationContext = {},
): CoordinationValidationResult<ExecutionReference> {
  const issues: CoordinationValidationIssue[] = []
  if (!isRecord(value)) {
    return { ok: false, issues: [{ code: 'INVALID_SHAPE', path: '$', message: '执行引用必须是对象。' }] }
  }
  validateExactKeys(value, ['dispatchId', 'adapterExecutionId', 'taskId'], '$', issues)
  validateExecutionReferenceFields(value, '$', issues, context)
  return issues.length === 0
    ? { ok: true, value: value as unknown as ExecutionReference }
    : { ok: false, issues }
}

export function validateExecutionReceipt(
  value: unknown,
  context: CoordinationValidationContext = {},
): CoordinationValidationResult<ExecutionReceipt> {
  const issues: CoordinationValidationIssue[] = []
  if (!isRecord(value)) {
    return { ok: false, issues: [{ code: 'INVALID_SHAPE', path: '$', message: '执行收据必须是对象。' }] }
  }
  validateExactKeys(value, ['dispatchId', 'adapterExecutionId', 'taskId', 'state', 'acceptedAt'], '$', issues)
  validateExecutionReferenceFields(value, '$', issues, context)
  if (typeof value.state !== 'string' || !executionStates.has(value.state)) {
    push(issues, 'INVALID_STATE', 'state', '执行状态无效。')
  }
  validateIsoDate(value.acceptedAt, 'acceptedAt', issues)
  return issues.length === 0
    ? { ok: true, value: value as unknown as ExecutionReceipt }
    : { ok: false, issues }
}

const validateExecutionError = (
  value: unknown,
  path: string,
  issues: CoordinationValidationIssue[],
): value is ExecutionAdapterError => {
  if (!isRecord(value)) {
    push(issues, 'INVALID_SHAPE', path, '执行错误必须是对象。')
    return false
  }
  validateExactKeys(value, ['code', 'retryable', 'message', 'retryAfterSeconds'], path, issues)
  if (typeof value.code !== 'string' || !executionErrorCodes.has(value.code)) {
    push(issues, 'INVALID_SHAPE', `${path}.code`, '执行错误码无效。')
  }
  if (typeof value.retryable !== 'boolean') {
    push(issues, 'INVALID_SHAPE', `${path}.retryable`, 'retryable 必须是布尔值。')
  }
  validateText(value.message, `${path}.message`, issues, { max: 500 })
  if (value.retryAfterSeconds !== undefined
    && (!Number.isInteger(value.retryAfterSeconds) || Number(value.retryAfterSeconds) < 0)) {
    push(issues, 'INVALID_SHAPE', `${path}.retryAfterSeconds`, '重试等待时间必须是非负整数。')
  }
  return true
}

const validateExecutionResult = (
  value: unknown,
  path: string,
  issues: CoordinationValidationIssue[],
  context: CoordinationValidationContext,
): value is TaskExecutionResult => {
  if (!isRecord(value)) {
    push(issues, 'INVALID_SHAPE', path, '执行结果必须是对象。')
    return false
  }
  validateExactKeys(
    value,
    ['taskId', 'providerId', 'summary', 'outputText', 'changedFiles', 'verification', 'reviewNote', 'handoff', 'usage', 'cost'],
    path,
    issues,
  )
  validateId(value.taskId, `${path}.taskId`, issues)
  validateProviderId(value.providerId, `${path}.providerId`, issues)
  validateText(value.summary, `${path}.summary`, issues)
  if (value.outputText !== undefined) validateText(value.outputText, `${path}.outputText`, issues, { allowEmpty: true, max: 50_000 })
  validateStringArray(value.changedFiles, `${path}.changedFiles`, issues, { pathValues: true })
  validateVerification(value.verification, `${path}.verification`, issues)
  if (value.reviewNote !== undefined) validateText(value.reviewNote, `${path}.reviewNote`, issues, { allowEmpty: true })
  if (value.handoff !== undefined) {
    if (!isRecord(value.handoff)) {
      push(issues, 'INVALID_SHAPE', `${path}.handoff`, '交接包必须是对象。')
    } else {
      validateExactKeys(value.handoff, ['summary', 'keyDecisions', 'artifacts', 'openQuestions'], `${path}.handoff`, issues)
      validateText(value.handoff.summary, `${path}.handoff.summary`, issues)
      validateStringArray(value.handoff.keyDecisions, `${path}.handoff.keyDecisions`, issues)
      validateArtifacts(value.handoff.artifacts, `${path}.handoff.artifacts`, issues)
      validateStringArray(value.handoff.openQuestions, `${path}.handoff.openQuestions`, issues)
    }
  }
  if (value.usage !== undefined) {
    if (!isRecord(value.usage)) {
      push(issues, 'INVALID_SHAPE', `${path}.usage`, 'Token 使用量必须是对象。')
    } else {
      validateExactKeys(value.usage, ['inputTokens', 'outputTokens'], `${path}.usage`, issues)
      for (const key of ['inputTokens', 'outputTokens'] as const) {
        if (value.usage[key] !== undefined
          && (!Number.isInteger(value.usage[key]) || Number(value.usage[key]) < 0)) {
          push(issues, 'INVALID_SHAPE', `${path}.usage.${key}`, 'Token 必须是非负整数。')
        }
      }
    }
  }
  if (value.cost !== undefined) {
    if (!isRecord(value.cost)) {
      push(issues, 'INVALID_SHAPE', `${path}.cost`, '费用必须是对象。')
    } else {
      validateExactKeys(value.cost, ['amount', 'currency'], `${path}.cost`, issues)
      if (typeof value.cost.amount !== 'number' || !Number.isFinite(value.cost.amount) || value.cost.amount < 0) {
        push(issues, 'INVALID_SHAPE', `${path}.cost.amount`, '费用必须是非负有限数。')
      }
      if (typeof value.cost.currency !== 'string' || !/^[A-Z]{3}$/.test(value.cost.currency)) {
        push(issues, 'INVALID_SHAPE', `${path}.cost.currency`, '币种必须是三位大写代码。')
      }
    }
  }
  if (context.taskId && value.taskId !== context.taskId) {
    push(issues, 'TASK_MISMATCH', `${path}.taskId`, '结果任务 ID 与执行任务不一致。')
  }
  if (context.providerId && value.providerId !== context.providerId) {
    push(issues, 'TASK_MISMATCH', `${path}.providerId`, '结果 Provider 与实际执行 Provider 不一致。')
  }
  return true
}

export function validateExecutionSnapshot(
  value: unknown,
  context: CoordinationValidationContext = {},
): CoordinationValidationResult<ExecutionSnapshot> {
  const issues: CoordinationValidationIssue[] = []
  if (!isRecord(value)) {
    return { ok: false, issues: [{ code: 'INVALID_SHAPE', path: '$', message: '执行快照必须是对象。' }] }
  }
  validateExactKeys(
    value,
    ['dispatchId', 'adapterExecutionId', 'taskId', 'state', 'observedAt', 'result', 'error'],
    '$',
    issues,
  )
  validateExecutionReferenceFields(value, '$', issues, context)
  const stateValid = typeof value.state === 'string' && executionStates.has(value.state)
  if (!stateValid) push(issues, 'INVALID_STATE', 'state', '执行状态无效。')
  validateIsoDate(value.observedAt, 'observedAt', issues)
  if (value.result !== undefined) validateExecutionResult(value.result, 'result', issues, context)
  if (value.error !== undefined) validateExecutionError(value.error, 'error', issues)
  if (stateValid) {
    if (value.state === 'completed') {
      if (value.result === undefined) push(issues, 'INVALID_STATE', 'result', '完成状态必须包含匹配的执行结果。')
      if (value.error !== undefined) push(issues, 'INVALID_STATE', 'error', '完成状态不能同时包含错误。')
    } else if (value.result !== undefined) {
      push(issues, 'INVALID_STATE', 'result', '只有完成状态可以包含正式执行结果。')
    }
    if ((value.state === 'failed' || value.state === 'unknown') && value.error === undefined) {
      push(issues, 'INVALID_STATE', 'error', '失败或未知状态必须包含安全错误。')
    }
  }
  return issues.length === 0
    ? { ok: true, value: value as unknown as ExecutionSnapshot }
    : { ok: false, issues }
}

export function validateEvaluationReport(
  value: unknown,
  context: CoordinationValidationContext = {},
): CoordinationValidationResult<EvaluationReport> {
  const issues: CoordinationValidationIssue[] = []
  if (!isRecord(value)) {
    return { ok: false, issues: [{ code: 'INVALID_SHAPE', path: '$', message: '评价报告必须是对象。' }] }
  }
  validateExactKeys(
    value,
    ['evaluationId', 'dispatchId', 'taskId', 'verdict', 'verification', 'method', 'ruleVersion', 'comparisonBasis', 'evidence', 'note', 'createdAt'],
    '$',
    issues,
  )
  validateId(value.evaluationId, 'evaluationId', issues)
  validateId(value.dispatchId, 'dispatchId', issues)
  validateId(value.taskId, 'taskId', issues)
  if (context.dispatchId && value.dispatchId !== context.dispatchId) {
    push(issues, 'TASK_MISMATCH', 'dispatchId', '评价报告与派发 ID 不一致。')
  }
  if (context.taskId && value.taskId !== context.taskId) {
    push(issues, 'TASK_MISMATCH', 'taskId', '评价报告与任务 ID 不一致。')
  }
  if (typeof value.verdict !== 'string' || !evaluationVerdicts.has(value.verdict)) {
    push(issues, 'INVALID_SHAPE', 'verdict', '评价结论无效。')
  }
  validateVerification(value.verification, 'verification', issues)
  if (typeof value.method !== 'string' || !evaluationMethods.has(value.method)) {
    push(issues, 'INVALID_SHAPE', 'method', '评价方法无效。')
  }
  validateText(value.ruleVersion, 'ruleVersion', issues, { max: 160 })
  validateText(value.comparisonBasis, 'comparisonBasis', issues, { max: 1_000 })
  validateText(value.note, 'note', issues, { allowEmpty: true, max: 2_000 })
  validateIsoDate(value.createdAt, 'createdAt', issues)
  if (!Array.isArray(value.evidence) || value.evidence.length > MAX_COORDINATION_ITEMS) {
    push(issues, Array.isArray(value.evidence) ? 'LIMIT_EXCEEDED' : 'INVALID_SHAPE', 'evidence', '证据引用必须是受限数组。')
  } else {
    value.evidence.forEach((item, index) => {
      const itemPath = `evidence[${index}]`
      if (!isRecord(item)) {
        push(issues, 'INVALID_SHAPE', itemPath, '证据引用必须是对象。')
        return
      }
      validateExactKeys(item, ['type', 'reference', 'summary'], itemPath, issues)
      if (typeof item.type !== 'string' || !evidenceTypes.has(item.type)) {
        push(issues, 'INVALID_SHAPE', `${itemPath}.type`, '证据类型无效。')
      }
      if (!validateText(item.reference, `${itemPath}.reference`, issues, { max: 256 })) return
      const reference = String(item.reference)
      if (/^[\\/]/.test(reference)
        || /^[A-Za-z]:/.test(reference)
        || reference.split(/[\\/]+/).includes('..')) {
        push(issues, 'INVALID_PATH', `${itemPath}.reference`, '证据引用必须是非敏感的相对或不透明标识。')
      }
      validateText(item.summary, `${itemPath}.summary`, issues, { max: 1_000 })
    })
  }
  return issues.length === 0
    ? { ok: true, value: value as unknown as EvaluationReport }
    : { ok: false, issues }
}

export function validateAcceptancePolicy(
  value: unknown,
): CoordinationValidationResult<AcceptancePolicy> {
  const issues: CoordinationValidationIssue[] = []
  if (!isRecord(value)) {
    return { ok: false, issues: [{ code: 'INVALID_SHAPE', path: '$', message: '验收策略必须是对象。' }] }
  }
  validateExactKeys(value, ['mode', 'trustedMethods', 'maxAttempts'], '$', issues)
  if (!['manual', 'trusted-evaluation'].includes(String(value.mode))) {
    push(issues, 'INVALID_SHAPE', 'mode', '验收策略模式无效。')
  }
  if (!Array.isArray(value.trustedMethods) || value.trustedMethods.length > EVALUATION_METHODS.length) {
    push(issues, 'INVALID_SHAPE', 'trustedMethods', '受信评价方法必须是数组。')
  } else {
    const methods = new Set<string>()
    value.trustedMethods.forEach((method, index) => {
      if (typeof method !== 'string' || !evaluationMethods.has(method) || methods.has(method)) {
        push(issues, 'INVALID_SHAPE', `trustedMethods[${index}]`, '受信评价方法无效或重复。')
      }
      if (typeof method === 'string') methods.add(method)
    })
  }
  if (!Number.isInteger(value.maxAttempts) || Number(value.maxAttempts) < 1 || Number(value.maxAttempts) > 100) {
    push(issues, 'INVALID_SHAPE', 'maxAttempts', '最大尝试次数必须是 1 到 100 的整数。')
  }
  return issues.length === 0
    ? { ok: true, value: value as unknown as AcceptancePolicy }
    : { ok: false, issues }
}

export function validateAcceptanceDecision(
  value: unknown,
  context: CoordinationValidationContext = {},
): CoordinationValidationResult<AcceptanceDecision> {
  const issues: CoordinationValidationIssue[] = []
  if (!isRecord(value)) {
    return { ok: false, issues: [{ code: 'INVALID_SHAPE', path: '$', message: '验收建议必须是对象。' }] }
  }
  validateExactKeys(
    value,
    ['evaluationId', 'taskId', 'dispatchId', 'action', 'reason', 'requiresHumanConfirmation'],
    '$',
    issues,
  )
  validateId(value.evaluationId, 'evaluationId', issues)
  validateId(value.taskId, 'taskId', issues)
  validateId(value.dispatchId, 'dispatchId', issues)
  if (context.taskId && value.taskId !== context.taskId) {
    push(issues, 'TASK_MISMATCH', 'taskId', '验收建议与任务 ID 不一致。')
  }
  if (context.dispatchId && value.dispatchId !== context.dispatchId) {
    push(issues, 'TASK_MISMATCH', 'dispatchId', '验收建议与派发 ID 不一致。')
  }
  if (typeof value.action !== 'string' || !decisionActions.has(value.action)) {
    push(issues, 'INVALID_SHAPE', 'action', '验收动作无效。')
  }
  if (typeof value.reason !== 'string' || !decisionReasons.has(value.reason)) {
    push(issues, 'INVALID_SHAPE', 'reason', '验收原因无效。')
  }
  if (typeof value.requiresHumanConfirmation !== 'boolean') {
    push(issues, 'INVALID_SHAPE', 'requiresHumanConfirmation', '人工确认标记必须是布尔值。')
  }
  if (value.action === 'complete' && value.requiresHumanConfirmation !== false) {
    push(issues, 'INVALID_STATE', 'requiresHumanConfirmation', '自动完成建议不能同时要求人工确认。')
  }
  return issues.length === 0
    ? { ok: true, value: value as unknown as AcceptanceDecision }
    : { ok: false, issues }
}
