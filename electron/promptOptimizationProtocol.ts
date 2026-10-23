export const PROMPT_OPTIMIZATION_MAX_PROMPT_LENGTH = 8_000
export const PROMPT_OPTIMIZATION_MAX_FILES = 20
export const PROMPT_OPTIMIZATION_MAX_FILE_SIZE = 100 * 1024 * 1024
export const PROMPT_OPTIMIZATION_MAX_TOTAL_FILE_SIZE = 500 * 1024 * 1024
export const PROMPT_OPTIMIZATION_MAX_BODY_BYTES = 32 * 1024
export const PROMPT_OPTIMIZATION_MAX_OUTPUT_LENGTH = 12_000

const TASK_TYPES = new Set(['coding', 'analysis', 'writing', 'research', 'testing', 'mixed', 'general'])

export interface PromptOptimizationFile {
  name: string
  type: string
  size: number
}

export interface PromptOptimizationRequest {
  prompt: string
  taskType: string
  files: PromptOptimizationFile[]
}

export type PromptOptimizationErrorCode =
  | 'INVALID_REQUEST'
  | 'RATE_LIMITED'
  | 'UPSTREAM_TIMEOUT'
  | 'UPSTREAM_UNAVAILABLE'
  | 'INVALID_RESPONSE'

export type PromptOptimizationResult =
  | { ok: true; optimizedPrompt: string; provider: 'deepseek' }
  | { ok: false; code: PromptOptimizationErrorCode; retryAfterSeconds?: number }

const isFile = (value: unknown): value is PromptOptimizationFile => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const file = value as Partial<PromptOptimizationFile>
  return typeof file.name === 'string'
    && file.name.trim().length > 0
    && file.name.length <= 512
    && typeof file.type === 'string'
    && file.type.trim().length > 0
    && file.type.length <= 256
    && typeof file.size === 'number'
    && Number.isFinite(file.size)
    && file.size >= 0
    && file.size <= PROMPT_OPTIMIZATION_MAX_FILE_SIZE
}

export const isPromptOptimizationRequest = (value: unknown): value is PromptOptimizationRequest => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const request = value as Partial<PromptOptimizationRequest>
  if (typeof request.prompt !== 'string'
    || request.prompt.trim().length === 0
    || request.prompt.length > PROMPT_OPTIMIZATION_MAX_PROMPT_LENGTH
    || typeof request.taskType !== 'string'
    || !TASK_TYPES.has(request.taskType)
    || !Array.isArray(request.files)
    || request.files.length > PROMPT_OPTIMIZATION_MAX_FILES
    || !request.files.every(isFile)) return false
  return request.files.reduce((total, file) => total + file.size, 0) <= PROMPT_OPTIMIZATION_MAX_TOTAL_FILE_SIZE
}

export const sanitizePromptOptimizationRequest = (value: unknown): PromptOptimizationRequest | null => {
  if (!isPromptOptimizationRequest(value)) return null
  return {
    prompt: value.prompt,
    taskType: value.taskType,
    files: value.files.map(file => ({ name: file.name, type: file.type, size: file.size })),
  }
}

export const isPromptOptimizationResult = (value: unknown): value is PromptOptimizationResult => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const result = value as Partial<PromptOptimizationResult>
  if (result.ok === true) {
    return Object.keys(result).length === 3
      && result.provider === 'deepseek'
      && typeof result.optimizedPrompt === 'string'
      && result.optimizedPrompt.trim().length > 0
      && result.optimizedPrompt.length <= PROMPT_OPTIMIZATION_MAX_OUTPUT_LENGTH
  }
  if (result.ok !== false || ![
    'INVALID_REQUEST', 'RATE_LIMITED', 'UPSTREAM_TIMEOUT', 'UPSTREAM_UNAVAILABLE', 'INVALID_RESPONSE',
  ].includes(result.code ?? '')) return false
  const allowedKeys = result.retryAfterSeconds === undefined ? 2 : 3
  return Object.keys(result).length === allowedKeys
    && (result.retryAfterSeconds === undefined
      || (Number.isSafeInteger(result.retryAfterSeconds) && result.retryAfterSeconds > 0))
}
