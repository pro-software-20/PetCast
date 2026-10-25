export const TASK_EXECUTION_CATEGORIES = ['coding', 'testing'] as const
export type TaskExecutionCategory = (typeof TASK_EXECUTION_CATEGORIES)[number]

export interface TaskExecutionFileScope {
  readPaths: string[]
  allowedWritePaths: string[]
  forbiddenPaths: string[]
  outputPaths: string[]
}

export interface PrepareCodexTaskExecutionRequest {
  requestId: string
  taskId: string
  workspaceId: string
  expectedScopeId: string
  prompt: string
  category: TaskExecutionCategory
  scope: TaskExecutionFileScope
  dependencySummaries: string[]
}

export type TaskExecutionErrorCode =
  | 'INVALID_REQUEST'
  | 'NO_WORKSPACE'
  | 'ACCOUNT_MISMATCH'
  | 'CODEX_UNAVAILABLE'
  | 'PATH_NOT_ALLOWED'
  | 'INPUT_TOO_LARGE'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'SOURCE_CHANGED'
  | 'ARTIFACT_NOT_FOUND'
  | 'ARTIFACT_EXPIRED'
  | 'CLEANUP_FAILED'
  | 'UNSAFE_CHANGES'
  | 'LOG_PERSISTENCE_FAILED'
  | 'PROVIDER_FAILED'

export interface PreparedCodexTaskExecution {
  executionId: string
  model: string
  preparedFileCount: number
  preparedBytes: number
  warnings: string[]
}

export interface TaskExecutionUsage {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number | null
}

export interface CodexTaskExecutionResult {
  artifactId: string
  summary: string
  outputText: string
  changedFiles: string[]
  usage: TaskExecutionUsage | null
}

export interface TaskExecutionArtifactView {
  artifactId: string
  changedFiles: string[]
  diff: string
  safetyStatus: 'safe'
}

export type TaskExecutionOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; code: TaskExecutionErrorCode; message: string }

export interface TaskExecutionEvent {
  executionId: string
  stage: 'preparing' | 'running' | 'review' | 'applying' | 'applied' | 'discarded' | 'interrupted'
  message: string
  code?: TaskExecutionErrorCode
}

export const TASK_EXECUTION_MESSAGES: Record<TaskExecutionErrorCode, string> = {
  INVALID_REQUEST: '自动执行请求无效。',
  NO_WORKSPACE: '请重新选择并确认当前项目工作区。',
  ACCOUNT_MISMATCH: '当前 Codex 账号与页面已确认账号不一致，请重新读取真实额度。',
  CODEX_UNAVAILABLE: '本机 Codex 不可用或尚未登录。',
  PATH_NOT_ALLOWED: '文件授权范围无效或包含越权路径。',
  INPUT_TOO_LARGE: '授权文件或执行输出超过安全上限。',
  TIMEOUT: 'Codex 执行超时，已停止本次任务。',
  CANCELLED: 'Codex 执行已取消。',
  SOURCE_CHANGED: '原项目文件已发生变化，为避免覆盖，改动未应用。',
  ARTIFACT_NOT_FOUND: '执行产物已失效，请核对执行记录后重新运行。',
  ARTIFACT_EXPIRED: '待审核改动已超过 30 分钟并失效，请核对执行记录后重新运行。',
  CLEANUP_FAILED: '临时执行文件暂未清理完成，请稍后重试。',
  UNSAFE_CHANGES: '检测到删除、二进制、越权或其他不安全改动，整次结果已拒绝。',
  LOG_PERSISTENCE_FAILED: '执行日志保存失败；为避免重复计费，不会自动重跑。',
  PROVIDER_FAILED: 'Codex 未能完成任务，请查看安全摘要后人工处理。',
}

const ID = /^[A-Za-z0-9._:-]{1,160}$/
const SCOPE = /^codex-[a-f0-9]{64}$/
const safePath = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= 500 && value === value.trim()
  && !/[\u0000-\u001f:]/.test(value)
  && !value.includes('\\') && !value.startsWith('/')
  && value.split('/').every(part => part !== '' && part !== '.' && part !== '..')

export function validatePrepareCodexTaskExecutionRequest(value: unknown): PrepareCodexTaskExecutionRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_REQUEST')
  const request = value as Record<string, unknown>
  if (!ID.test(String(request.requestId)) || !ID.test(String(request.taskId))
    || !/^[a-f0-9]{64}$/.test(String(request.workspaceId)) || !SCOPE.test(String(request.expectedScopeId))
    || typeof request.prompt !== 'string' || !request.prompt.trim() || request.prompt.length > 32_000
    || !TASK_EXECUTION_CATEGORIES.includes(request.category as TaskExecutionCategory)
    || !request.scope || typeof request.scope !== 'object' || Array.isArray(request.scope)
    || !Array.isArray(request.dependencySummaries) || request.dependencySummaries.length > 50
    || request.dependencySummaries.some(item => typeof item !== 'string' || item.length > 500)) {
    throw new Error('INVALID_REQUEST')
  }
  const rawScope = request.scope as Record<string, unknown>
  const keys = ['readPaths', 'allowedWritePaths', 'forbiddenPaths', 'outputPaths'] as const
  for (const key of keys) {
    const paths = rawScope[key]
    if (!Array.isArray(paths) || paths.length > 200 || paths.some(path => !safePath(path))
      || new Set(paths).size !== paths.length) throw new Error('PATH_NOT_ALLOWED')
  }
  const writePaths = rawScope.allowedWritePaths as string[]
  const forbiddenPaths = rawScope.forbiddenPaths as string[]
  const isWithin = (candidate: string, parent: string) => candidate === parent || candidate.startsWith(`${parent}/`)
  if ((rawScope.outputPaths as string[]).some(output => (
    !writePaths.some(writePath => isWithin(output, writePath))
    || forbiddenPaths.some(blocked => isWithin(output, blocked))
  ))) throw new Error('PATH_NOT_ALLOWED')
  return {
    requestId: request.requestId as string,
    taskId: request.taskId as string,
    workspaceId: request.workspaceId as string,
    expectedScopeId: request.expectedScopeId as string,
    prompt: (request.prompt as string).trim(),
    category: request.category as TaskExecutionCategory,
    scope: {
      readPaths: [...rawScope.readPaths as string[]],
      allowedWritePaths: [...rawScope.allowedWritePaths as string[]],
      forbiddenPaths: [...rawScope.forbiddenPaths as string[]],
      outputPaths: [...rawScope.outputPaths as string[]],
    },
    dependencySummaries: [...request.dependencySummaries as string[]],
  }
}

export const isTaskExecutionId = (value: unknown): value is string => (
  typeof value === 'string' && /^[A-Za-z0-9-]{1,100}$/.test(value)
)
