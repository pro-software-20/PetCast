export const TASK_PLANNING_MAX_BODY_BYTES = 64 * 1024
export const TASK_PLANNING_MAX_RESPONSE_BYTES = 512 * 1024
export const TASK_PLANNING_MAX_PROMPT_LENGTH = 8_000
export const TASK_PLANNING_MAX_FILES = 20
export const TASK_PLANNING_MAX_FILE_SIZE = 100 * 1024 * 1024
export const TASK_PLANNING_MAX_TOTAL_FILE_SIZE = 500 * 1024 * 1024

const TASK_TYPES = new Set(['coding', 'analysis', 'writing', 'research', 'testing', 'mixed', 'general'])
const COMPLEXITIES = new Set(['low', 'medium', 'high'])
const OPTIMIZATION_SOURCES = new Set(['deepseek', 'local'])
const PROVIDER_CAPABILITIES = ['planning', 'text-generation', 'research', 'coding', 'file-editing', 'testing', 'vision'] as const
const EXECUTION_MODES = ['manual', 'api', 'local-agent'] as const
const WORK_CATEGORIES = ['planning', 'coding', 'testing', 'research', 'analysis', 'writing', 'review', 'vision', 'general'] as const
const CONFIDENCES = ['high', 'medium', 'low'] as const
const CAPABILITIES = new Set<string>(PROVIDER_CAPABILITIES)
const MODES = new Set<string>(EXECUTION_MODES)
const CATEGORIES = new Set<string>(WORK_CATEGORIES)
const CONFIDENCE_VALUES = new Set<string>(CONFIDENCES)
const PROVIDER_ID_PATTERN = /^(?:local|codex|deepseek|doubao|custom:[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)$/
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const PLAN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

export type TaskPlanningProviderId = string
export type TaskPlanningProviderCapability = (typeof PROVIDER_CAPABILITIES)[number]

export interface TaskPlanningFile {
  name: string
  type: string
  size: number
}

export interface TaskPlanningAnalysis {
  taskType: string
  complexity: 'low' | 'medium' | 'high'
  estimatedInputTokens: { min: number; max: number }
  estimatedOutputTokens: { min: number; max: number }
  estimationBasis: 'heuristic-metadata'
  assumptions: string[]
  optimizedPrompt: string
  promptOptimizationSource: 'deepseek' | 'local'
  canRunInParallel: boolean
  parallelPlan: string[]
  warnings: string[]
}

export interface TaskPlanningPlan {
  schemaVersion: 1
  id: string
  title: string
  goal: string
  assumptions: string[]
  tasks: Array<{
    id: string
    title: string
    description: string
    dependsOn: string[]
    recommendedProviderId: TaskPlanningProviderId
    providerRecommendation?: {
      category: string
      requiredCapabilities: TaskPlanningProviderCapability[]
      confidence: string
      reason: string
    }
    executionMode: 'manual'
    prompt: string
    files: {
      inputs: Array<{ kind: 'attachment'; name: string; type: string; size: number }>
      readPaths: string[]
      allowedWritePaths: string[]
      forbiddenPaths: string[]
      outputPaths: string[]
    }
    expectedDeliverables: string[]
    acceptanceChecks: string[]
  }>
  finalAcceptanceChecks: string[]
}

export interface TaskPlanningProvider {
  id: TaskPlanningProviderId
  displayName: string
  capabilities: TaskPlanningProviderCapability[]
  executionModes: Array<'manual' | 'api' | 'local-agent'>
}

export interface TaskPlanningRequest {
  prompt: string
  analysis: TaskPlanningAnalysis
  files: TaskPlanningFile[]
  providers: TaskPlanningProvider[]
}

export interface TaskPlanningIpcRequest {
  requestId: string
  input: TaskPlanningRequest
}

export type TaskPlanningServiceErrorCode =
  | 'INVALID_REQUEST'
  | 'RATE_LIMITED'
  | 'UPSTREAM_TIMEOUT'
  | 'UPSTREAM_UNAVAILABLE'
  | 'INVALID_RESPONSE'

export type TaskPlanningServiceResult =
  | { ok: true; plan: TaskPlanningPlan; provider: 'deepseek' }
  | { ok: false; code: TaskPlanningServiceErrorCode; retryAfterSeconds?: number }

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

const hasOnlyKeys = (value: Record<string, unknown>, allowed: readonly string[]) => (
  Object.keys(value).every(key => allowed.includes(key))
)

const isBoundedString = (value: unknown, max: number, allowEmpty = false): value is string => (
  typeof value === 'string'
  && value.length <= max
  && (allowEmpty || value.trim().length > 0)
)

const sanitizeStringArray = (value: unknown, maxItems: number, maxLength: number): string[] | null => {
  if (!Array.isArray(value) || value.length > maxItems) return null
  const result: string[] = []
  for (const item of value) {
    if (!isBoundedString(item, maxLength)) return null
    result.push(item.trim())
  }
  return result
}

const sanitizeRange = (value: unknown) => {
  if (!isRecord(value) || !hasOnlyKeys(value, ['min', 'max'])) return null
  if (!Number.isSafeInteger(value.min) || !Number.isSafeInteger(value.max)
    || (value.min as number) < 0 || (value.max as number) < (value.min as number)) return null
  return { min: value.min as number, max: value.max as number }
}

const sanitizeFile = (value: unknown): TaskPlanningFile | null => {
  if (!isRecord(value) || !hasOnlyKeys(value, ['name', 'type', 'size'])) return null
  if (!isBoundedString(value.name, 512) || !isBoundedString(value.type, 256)
    || typeof value.size !== 'number' || !Number.isFinite(value.size)
    || value.size < 0 || value.size > TASK_PLANNING_MAX_FILE_SIZE) return null
  return { name: value.name, type: value.type, size: value.size }
}

const sanitizeAnalysis = (value: unknown): TaskPlanningAnalysis | null => {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'taskType', 'complexity', 'estimatedInputTokens', 'estimatedOutputTokens',
    'estimationBasis', 'assumptions', 'optimizedPrompt', 'promptOptimizationSource',
    'canRunInParallel', 'parallelPlan', 'warnings',
  ])) return null
  if (typeof value.taskType !== 'string' || !TASK_TYPES.has(value.taskType)
    || typeof value.complexity !== 'string' || !COMPLEXITIES.has(value.complexity)
    || value.estimationBasis !== 'heuristic-metadata'
    || typeof value.promptOptimizationSource !== 'string'
    || !OPTIMIZATION_SOURCES.has(value.promptOptimizationSource)
    || typeof value.canRunInParallel !== 'boolean'
    || !isBoundedString(value.optimizedPrompt, 12_000)) return null
  const estimatedInputTokens = sanitizeRange(value.estimatedInputTokens)
  const estimatedOutputTokens = sanitizeRange(value.estimatedOutputTokens)
  const assumptions = sanitizeStringArray(value.assumptions, 50, 2_000)
  const parallelPlan = sanitizeStringArray(value.parallelPlan, 50, 2_000)
  const warnings = sanitizeStringArray(value.warnings, 50, 2_000)
  if (!estimatedInputTokens || !estimatedOutputTokens || !assumptions || !parallelPlan || !warnings) return null
  return {
    taskType: value.taskType,
    complexity: value.complexity as TaskPlanningAnalysis['complexity'],
    estimatedInputTokens,
    estimatedOutputTokens,
    estimationBasis: 'heuristic-metadata',
    assumptions,
    optimizedPrompt: value.optimizedPrompt,
    promptOptimizationSource: value.promptOptimizationSource as TaskPlanningAnalysis['promptOptimizationSource'],
    canRunInParallel: value.canRunInParallel,
    parallelPlan,
    warnings,
  }
}

const sanitizeProvider = (value: unknown): TaskPlanningProvider | null => {
  if (!isRecord(value) || !hasOnlyKeys(value, ['id', 'displayName', 'capabilities', 'executionModes'])) return null
  if (typeof value.id !== 'string' || !PROVIDER_ID_PATTERN.test(value.id)
    || !isBoundedString(value.displayName, 128)
    || !Array.isArray(value.capabilities) || value.capabilities.length === 0
    || !Array.isArray(value.executionModes) || value.executionModes.length === 0) return null
  const capabilities = [...new Set(value.capabilities)]
  const executionModes = [...new Set(value.executionModes)]
  if (capabilities.some(item => typeof item !== 'string' || !CAPABILITIES.has(item))
    || executionModes.some(item => typeof item !== 'string' || !MODES.has(item))) return null
  return {
    id: value.id,
    displayName: value.displayName,
    capabilities: capabilities as TaskPlanningProviderCapability[],
    executionModes: executionModes as TaskPlanningProvider['executionModes'],
  }
}

export const sanitizeTaskPlanningRequest = (value: unknown): TaskPlanningRequest | null => {
  if (!isRecord(value) || !hasOnlyKeys(value, ['prompt', 'analysis', 'files', 'providers'])) return null
  if (typeof value.prompt !== 'string' || value.prompt.length > TASK_PLANNING_MAX_PROMPT_LENGTH
    || !Array.isArray(value.files) || value.files.length > TASK_PLANNING_MAX_FILES
    || !Array.isArray(value.providers) || value.providers.length === 0 || value.providers.length > 50) return null
  const analysis = sanitizeAnalysis(value.analysis)
  const files = value.files.map(sanitizeFile)
  const providers = value.providers.map(sanitizeProvider)
  if (!analysis || files.some(file => !file) || providers.some(provider => !provider)) return null
  const cleanFiles = files as TaskPlanningFile[]
  const cleanProviders = providers as TaskPlanningProvider[]
  if (cleanFiles.reduce((total, file) => total + file.size, 0) > TASK_PLANNING_MAX_TOTAL_FILE_SIZE
    || new Set(cleanProviders.map(provider => provider.id)).size !== cleanProviders.length) return null
  return { prompt: value.prompt, analysis, files: cleanFiles, providers: cleanProviders }
}

export const sanitizeTaskPlanningIpcRequest = (value: unknown): TaskPlanningIpcRequest | null => {
  if (!isRecord(value) || !hasOnlyKeys(value, ['requestId', 'input'])
    || typeof value.requestId !== 'string' || !REQUEST_ID_PATTERN.test(value.requestId)) return null
  const input = sanitizeTaskPlanningRequest(value.input)
  return input ? { requestId: value.requestId, input } : null
}

const attachmentKey = (value: TaskPlanningFile) => `${value.name}\0${value.type}\0${value.size}`

const sanitizeRecommendation = (
  value: unknown,
): TaskPlanningPlan['tasks'][number]['providerRecommendation'] | null => {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'category', 'requiredCapabilities', 'confidence', 'reason',
  ]) || typeof value.category !== 'string' || !CATEGORIES.has(value.category)
    || typeof value.confidence !== 'string' || !CONFIDENCE_VALUES.has(value.confidence)
    || !isBoundedString(value.reason, 2_000)
    || !Array.isArray(value.requiredCapabilities) || value.requiredCapabilities.length === 0) return null
  const capabilities = [...new Set(value.requiredCapabilities)]
  if (capabilities.some(item => typeof item !== 'string' || !CAPABILITIES.has(item))) return null
  return {
    category: value.category,
    requiredCapabilities: capabilities as TaskPlanningProviderCapability[],
    confidence: value.confidence,
    reason: value.reason.trim(),
  }
}

const isAcyclic = (tasks: TaskPlanningPlan['tasks']) => {
  const taskIds = new Set(tasks.map(task => task.id))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const byId = new Map(tasks.map(task => [task.id, task]))
  const visit = (id: string): boolean => {
    if (visited.has(id)) return true
    if (visiting.has(id)) return false
    visiting.add(id)
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      if (!taskIds.has(dependency) || !visit(dependency)) return false
    }
    visiting.delete(id)
    visited.add(id)
    return true
  }
  return tasks.every(task => visit(task.id))
}

/** Rebuilds a model-generated plan and rejects any file/path authority not present in the request. */
export const sanitizeRemoteTaskPlan = (
  value: unknown,
  request: TaskPlanningRequest,
): TaskPlanningPlan | null => {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'schemaVersion', 'id', 'title', 'goal', 'assumptions', 'tasks', 'finalAcceptanceChecks',
  ]) || value.schemaVersion !== 1 || !isBoundedString(value.id, 64)
    || !PLAN_ID_PATTERN.test(value.id) || !isBoundedString(value.title, 12_000)
    || !isBoundedString(value.goal, 12_000) || !Array.isArray(value.tasks)
    || value.tasks.length === 0 || value.tasks.length > 50) return null
  const assumptions = sanitizeStringArray(value.assumptions, 100, 12_000)
  const finalAcceptanceChecks = sanitizeStringArray(value.finalAcceptanceChecks, 100, 12_000)
  if (!assumptions || !finalAcceptanceChecks || finalAcceptanceChecks.length === 0) return null

  const allowedProviders = new Set(
    request.providers.filter(provider => provider.executionModes.includes('manual')).map(provider => provider.id),
  )
  const allowedAttachments = new Set(request.files.map(attachmentKey))
  const tasks: TaskPlanningPlan['tasks'] = []
  for (const rawTask of value.tasks) {
    if (!isRecord(rawTask) || !hasOnlyKeys(rawTask, [
      'id', 'title', 'description', 'dependsOn', 'recommendedProviderId',
      'providerRecommendation', 'executionMode', 'prompt', 'files',
      'expectedDeliverables', 'acceptanceChecks',
    ]) || !isBoundedString(rawTask.id, 64) || !PLAN_ID_PATTERN.test(rawTask.id)
      || !isBoundedString(rawTask.title, 12_000) || !isBoundedString(rawTask.description, 12_000)
      || !isBoundedString(rawTask.prompt, 12_000) || rawTask.executionMode !== 'manual'
      || typeof rawTask.recommendedProviderId !== 'string'
      || !allowedProviders.has(rawTask.recommendedProviderId)
      || !isRecord(rawTask.files)
      || !hasOnlyKeys(rawTask.files, ['inputs', 'readPaths', 'allowedWritePaths', 'forbiddenPaths', 'outputPaths'])
      || !Array.isArray(rawTask.files.inputs)
      || !Array.isArray(rawTask.files.allowedWritePaths) || rawTask.files.allowedWritePaths.length !== 0
      || !Array.isArray(rawTask.files.forbiddenPaths) || rawTask.files.forbiddenPaths.length !== 0
      || !Array.isArray(rawTask.files.outputPaths) || rawTask.files.outputPaths.length !== 0
      || (rawTask.files.readPaths !== undefined
        && (!Array.isArray(rawTask.files.readPaths) || rawTask.files.readPaths.length !== 0))) return null
    const dependsOn = sanitizeStringArray(rawTask.dependsOn, 50, 64)
    const expectedDeliverables = sanitizeStringArray(rawTask.expectedDeliverables, 100, 12_000)
    const acceptanceChecks = sanitizeStringArray(rawTask.acceptanceChecks, 100, 12_000)
    if (!dependsOn || new Set(dependsOn).size !== dependsOn.length
      || !expectedDeliverables?.length || !acceptanceChecks?.length) return null
    const recommendation = rawTask.providerRecommendation === undefined
      ? undefined
      : sanitizeRecommendation(rawTask.providerRecommendation)
    if (rawTask.providerRecommendation !== undefined && !recommendation) return null
    const inputs: TaskPlanningPlan['tasks'][number]['files']['inputs'] = []
    for (const input of rawTask.files.inputs) {
      if (!isRecord(input) || !hasOnlyKeys(input, ['kind', 'name', 'type', 'size']) || input.kind !== 'attachment') return null
      const file = sanitizeFile({ name: input.name, type: input.type, size: input.size })
      if (!file || !allowedAttachments.has(attachmentKey(file))) return null
      inputs.push({ kind: 'attachment', ...file })
    }
    tasks.push({
      id: rawTask.id,
      title: rawTask.title.trim(),
      description: rawTask.description.trim(),
      dependsOn,
      recommendedProviderId: rawTask.recommendedProviderId,
      ...(recommendation ? { providerRecommendation: recommendation } : {}),
      executionMode: 'manual',
      prompt: rawTask.prompt.trim(),
      files: {
        inputs,
        readPaths: [],
        allowedWritePaths: [],
        forbiddenPaths: [],
        outputPaths: [],
      },
      expectedDeliverables,
      acceptanceChecks,
    })
  }
  const ids = tasks.map(task => task.id)
  if (new Set(ids).size !== ids.length
    || tasks.some(task => task.dependsOn.includes(task.id)) || !isAcyclic(tasks)) return null
  return {
    schemaVersion: 1,
    id: value.id,
    title: value.title.trim(),
    goal: value.goal.trim(),
    assumptions,
    tasks,
    finalAcceptanceChecks,
  }
}

export const sanitizeTaskPlanningServiceResult = (
  value: unknown,
  request: TaskPlanningRequest,
): TaskPlanningServiceResult | null => {
  if (!isRecord(value)) return null
  if (value.ok === true) {
    if (!hasOnlyKeys(value, ['ok', 'plan', 'provider']) || value.provider !== 'deepseek') return null
    const plan = sanitizeRemoteTaskPlan(value.plan, request)
    return plan ? { ok: true, plan, provider: 'deepseek' } : null
  }
  if (value.ok !== false || !hasOnlyKeys(value, ['ok', 'code', 'retryAfterSeconds'])
    || !['INVALID_REQUEST', 'RATE_LIMITED', 'UPSTREAM_TIMEOUT', 'UPSTREAM_UNAVAILABLE', 'INVALID_RESPONSE']
      .includes(typeof value.code === 'string' ? value.code : '')) return null
  if (value.retryAfterSeconds !== undefined
    && (!Number.isSafeInteger(value.retryAfterSeconds) || (value.retryAfterSeconds as number) <= 0)) return null
  return {
    ok: false,
    code: value.code as TaskPlanningServiceErrorCode,
    ...(value.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: value.retryAfterSeconds as number }),
  }
}
