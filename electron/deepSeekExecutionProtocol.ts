export const DEEPSEEK_EXECUTION_ERROR_CODES = [
  'INVALID_INPUT',
  'UNAVAILABLE',
  'UNSUPPORTED_MODE',
  'TIMEOUT',
  'RATE_LIMITED',
  'NEEDS_INPUT',
  'CANCELLED',
  'EXECUTION_NOT_FOUND',
  'INVALID_RESPONSE',
  'FAILED',
] as const

export type DeepSeekExecutionErrorCode = (typeof DEEPSEEK_EXECUTION_ERROR_CODES)[number]
export type DeepSeekExecutionState =
  | 'queued'
  | 'running'
  | 'needs-input'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'unknown'

export interface DeepSeekExecutionError {
  code: DeepSeekExecutionErrorCode
  retryable: boolean
  message: string
  retryAfterSeconds?: number
}

export interface DeepSeekExecutionDispatchInput {
  dispatchId: string
  taskId: string
  title: string
  description: string
  prompt: string
  dependencySummaries: string[]
  acceptanceChecks: string[]
}

export interface DeepSeekExecutionReferenceInput {
  dispatchId: string
  adapterExecutionId: string
  taskId: string
}

export interface DeepSeekExecutionReceipt extends DeepSeekExecutionReferenceInput {
  state: 'queued' | 'running'
  acceptedAt: string
}

export interface DeepSeekExecutionResult {
  summary: string
  outputText: string
  verification: Array<{
    label: string
    status: 'passed' | 'failed' | 'not-run'
    details?: string
  }>
  usage?: {
    inputTokens?: number
    outputTokens?: number
  }
}

export interface DeepSeekExecutionSnapshot extends DeepSeekExecutionReferenceInput {
  state: DeepSeekExecutionState
  observedAt: string
  result?: DeepSeekExecutionResult
  error?: DeepSeekExecutionError
}

export type DeepSeekExecutionOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: DeepSeekExecutionError }

const ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$/
const errorCodes = new Set<string>(DEEPSEEK_EXECUTION_ERROR_CODES)
const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)
const exactKeys = (value: Record<string, unknown>, allowed: readonly string[]) => (
  Object.keys(value).every(key => allowed.includes(key))
)
const text = (value: unknown, max: number, allowEmpty = false): value is string => (
  typeof value === 'string'
  && value.length <= max
  && !value.includes('\0')
  && (allowEmpty || value.trim().length > 0)
)
const iso = (value: unknown): value is string => (
  typeof value === 'string'
  && !Number.isNaN(Date.parse(value))
  && new Date(value).toISOString() === value
)
const stringArray = (value: unknown, maxItems: number, maxLength: number): value is string[] => (
  Array.isArray(value)
  && value.length <= maxItems
  && value.every(item => text(item, maxLength))
)

export const sanitizeDeepSeekExecutionDispatchInput = (
  value: unknown,
): DeepSeekExecutionDispatchInput | null => {
  if (!isRecord(value) || !exactKeys(value, [
    'dispatchId', 'taskId', 'title', 'description', 'prompt',
    'dependencySummaries', 'acceptanceChecks',
  ]) || typeof value.dispatchId !== 'string' || !ID.test(value.dispatchId)
    || typeof value.taskId !== 'string' || !ID.test(value.taskId)
    || !text(value.title, 2_000) || !text(value.description, 8_000)
    || !text(value.prompt, 32_000)
    || !stringArray(value.dependencySummaries, 50, 500)
    || !stringArray(value.acceptanceChecks, 100, 2_000)) return null
  return {
    dispatchId: value.dispatchId,
    taskId: value.taskId,
    title: value.title.trim(),
    description: value.description.trim(),
    prompt: value.prompt.trim(),
    dependencySummaries: [...value.dependencySummaries],
    acceptanceChecks: [...value.acceptanceChecks],
  }
}

export const sanitizeDeepSeekExecutionReferenceInput = (
  value: unknown,
): DeepSeekExecutionReferenceInput | null => {
  if (!isRecord(value) || !exactKeys(value, ['dispatchId', 'adapterExecutionId', 'taskId'])
    || typeof value.dispatchId !== 'string' || !ID.test(value.dispatchId)
    || typeof value.adapterExecutionId !== 'string' || !ID.test(value.adapterExecutionId)
    || typeof value.taskId !== 'string' || !ID.test(value.taskId)) return null
  return {
    dispatchId: value.dispatchId,
    adapterExecutionId: value.adapterExecutionId,
    taskId: value.taskId,
  }
}

export const isDeepSeekExecutionError = (value: unknown): value is DeepSeekExecutionError => {
  if (!isRecord(value) || !exactKeys(value, ['code', 'retryable', 'message', 'retryAfterSeconds'])
    || typeof value.code !== 'string' || !errorCodes.has(value.code)
    || typeof value.retryable !== 'boolean' || !text(value.message, 500)) return false
  return value.retryAfterSeconds === undefined
    || (Number.isInteger(value.retryAfterSeconds) && Number(value.retryAfterSeconds) >= 0)
}

export const isDeepSeekExecutionReceipt = (value: unknown): value is DeepSeekExecutionReceipt => (
  isRecord(value)
  && exactKeys(value, ['dispatchId', 'adapterExecutionId', 'taskId', 'state', 'acceptedAt'])
  && sanitizeDeepSeekExecutionReferenceInput({
    dispatchId: value.dispatchId,
    adapterExecutionId: value.adapterExecutionId,
    taskId: value.taskId,
  }) !== null
  && (value.state === 'queued' || value.state === 'running')
  && iso(value.acceptedAt)
)

export const isDeepSeekExecutionSnapshot = (value: unknown): value is DeepSeekExecutionSnapshot => {
  if (!isRecord(value) || !exactKeys(value, [
    'dispatchId', 'adapterExecutionId', 'taskId', 'state', 'observedAt', 'result', 'error',
  ]) || sanitizeDeepSeekExecutionReferenceInput({
    dispatchId: value.dispatchId,
    adapterExecutionId: value.adapterExecutionId,
    taskId: value.taskId,
  }) === null || !['queued', 'running', 'needs-input', 'completed', 'failed', 'cancelled', 'unknown'].includes(String(value.state))
    || !iso(value.observedAt)) return false
  if (value.error !== undefined && !isDeepSeekExecutionError(value.error)) return false
  if (value.state === 'completed') {
    if (!isRecord(value.result) || !exactKeys(value.result, ['summary', 'outputText', 'verification', 'usage'])
      || !text(value.result.summary, 8_000) || !text(value.result.outputText, 50_000, true)
      || !Array.isArray(value.result.verification)) return false
  } else if (value.result !== undefined) return false
  if ((value.state === 'failed' || value.state === 'unknown') && value.error === undefined) return false
  return true
}
