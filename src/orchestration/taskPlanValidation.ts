import {
  BUILT_IN_PROVIDER_IDS,
  EXECUTION_MODES,
  PROVIDER_CAPABILITIES,
  RECOMMENDATION_CONFIDENCES,
  TASK_WORK_CATEGORIES,
  type ProviderId,
  type TaskNode,
  type TaskPlan,
} from '../types/taskOrchestration'
import { normalizeWorkspacePath, validateTaskPathScope } from './taskPathScope'

export const MAX_TASK_PLAN_TASKS = 50
export const MAX_TASK_PLAN_TEXT_LENGTH = 12_000

export type TaskPlanValidationIssueCode =
  | 'INVALID_SHAPE'
  | 'UNSUPPORTED_VERSION'
  | 'LIMIT_EXCEEDED'
  | 'DUPLICATE_TASK_ID'
  | 'DUPLICATE_DEPENDENCY'
  | 'UNKNOWN_DEPENDENCY'
  | 'SELF_DEPENDENCY'
  | 'CYCLIC_DEPENDENCY'
  | 'INVALID_PROVIDER_ID'
  | 'INVALID_PATH'

export interface TaskPlanValidationIssue {
  code: TaskPlanValidationIssueCode
  path: string
  message: string
}

export type TaskPlanValidationResult =
  | { ok: true; plan: TaskPlan }
  | { ok: false; issues: TaskPlanValidationIssue[] }

const PLAN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const CUSTOM_PROVIDER_ID_PATTERN = /^custom:[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/
const builtInProviderIds = new Set<string>(BUILT_IN_PROVIDER_IDS)
const executionModes = new Set<string>(EXECUTION_MODES)
const providerCapabilities = new Set<string>(PROVIDER_CAPABILITIES)
const recommendationConfidences = new Set<string>(RECOMMENDATION_CONFIDENCES)
const taskWorkCategories = new Set<string>(TASK_WORK_CATEGORIES)

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

const isProviderId = (value: unknown): value is ProviderId => (
  typeof value === 'string'
  && (builtInProviderIds.has(value) || CUSTOM_PROVIDER_ID_PATTERN.test(value))
)

const isSafeWorkspacePath = (value: unknown): value is string => {
  return typeof value === 'string' && normalizeWorkspacePath(value) === value
}

const pushIssue = (
  issues: TaskPlanValidationIssue[],
  code: TaskPlanValidationIssueCode,
  path: string,
  message: string,
) => issues.push({ code, path, message })

const validateRequiredString = (
  value: unknown,
  path: string,
  issues: TaskPlanValidationIssue[],
  options: { id?: boolean } = {},
) => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    pushIssue(issues, 'INVALID_SHAPE', path, '必须是非空字符串。')
    return false
  }
  if (value.length > MAX_TASK_PLAN_TEXT_LENGTH) {
    pushIssue(issues, 'LIMIT_EXCEEDED', path, `文本不能超过 ${MAX_TASK_PLAN_TEXT_LENGTH} 个字符。`)
    return false
  }
  if (options.id && !PLAN_ID_PATTERN.test(value)) {
    pushIssue(issues, 'INVALID_SHAPE', path, 'ID 只能包含字母、数字、下划线和连字符，且长度不超过 64。')
    return false
  }
  return true
}

const validateStringArray = (
  value: unknown,
  path: string,
  issues: TaskPlanValidationIssue[],
  requireItem: boolean,
) => {
  if (!Array.isArray(value)) {
    pushIssue(issues, 'INVALID_SHAPE', path, '必须是字符串数组。')
    return false
  }
  let valid = true
  if (requireItem && value.length === 0) {
    pushIssue(issues, 'INVALID_SHAPE', path, '至少需要一项。')
    valid = false
  }
  value.forEach((item, index) => {
    if (!validateRequiredString(item, `${path}[${index}]`, issues)) valid = false
  })
  return valid
}

const validatePathArray = (
  value: unknown,
  path: string,
  issues: TaskPlanValidationIssue[],
) => {
  if (!Array.isArray(value)) {
    pushIssue(issues, 'INVALID_SHAPE', path, '必须是工作区相对路径数组。')
    return
  }
  value.forEach((item, index) => {
    if (!isSafeWorkspacePath(item)) {
      pushIssue(issues, 'INVALID_PATH', `${path}[${index}]`, '必须是安全的工作区相对路径。')
    }
  })
}

const validateInputFiles = (
  value: unknown,
  path: string,
  issues: TaskPlanValidationIssue[],
) => {
  if (!Array.isArray(value)) {
    pushIssue(issues, 'INVALID_SHAPE', path, '必须是文件引用数组。')
    return
  }

  value.forEach((file, index) => {
    const filePath = `${path}[${index}]`
    if (!isRecord(file)) {
      pushIssue(issues, 'INVALID_SHAPE', filePath, '文件引用必须是对象。')
      return
    }
    if (file.kind === 'workspace') {
      if (!isSafeWorkspacePath(file.path)) {
        pushIssue(issues, 'INVALID_PATH', `${filePath}.path`, '必须是安全的工作区相对路径。')
      }
      return
    }
    if (file.kind === 'attachment') {
      validateRequiredString(file.name, `${filePath}.name`, issues)
      validateRequiredString(file.type, `${filePath}.type`, issues)
      if (typeof file.size !== 'number' || !Number.isFinite(file.size) || file.size < 0) {
        pushIssue(issues, 'INVALID_SHAPE', `${filePath}.size`, '附件大小必须是非负有限数。')
      }
      return
    }
    pushIssue(issues, 'INVALID_SHAPE', `${filePath}.kind`, '文件引用类型必须是 attachment 或 workspace。')
  })
}

type DependencyTask = Pick<TaskNode, 'id' | 'dependsOn'>

const validateProviderRecommendation = (
  value: unknown,
  path: string,
  issues: TaskPlanValidationIssue[],
) => {
  if (!isRecord(value)) {
    pushIssue(issues, 'INVALID_SHAPE', path, 'Provider 推荐信息必须是对象。')
    return
  }
  if (typeof value.category !== 'string' || !taskWorkCategories.has(value.category)) {
    pushIssue(issues, 'INVALID_SHAPE', `${path}.category`, '任务工作类型不受支持。')
  }
  if (typeof value.confidence !== 'string' || !recommendationConfidences.has(value.confidence)) {
    pushIssue(issues, 'INVALID_SHAPE', `${path}.confidence`, '推荐可信度必须是 high、medium 或 low。')
  }
  validateRequiredString(value.reason, `${path}.reason`, issues)
  if (!Array.isArray(value.requiredCapabilities) || value.requiredCapabilities.length === 0) {
    pushIssue(issues, 'INVALID_SHAPE', `${path}.requiredCapabilities`, '至少需要一项 Provider 能力。')
    return
  }
  const seen = new Set<string>()
  value.requiredCapabilities.forEach((capability, index) => {
    const capabilityPath = `${path}.requiredCapabilities[${index}]`
    if (typeof capability !== 'string' || !providerCapabilities.has(capability)) {
      pushIssue(issues, 'INVALID_SHAPE', capabilityPath, 'Provider 能力不受支持。')
    } else if (seen.has(capability)) {
      pushIssue(issues, 'INVALID_SHAPE', capabilityPath, 'Provider 能力不能重复。')
    }
    if (typeof capability === 'string') seen.add(capability)
  })
}

const validateTask = (
  value: unknown,
  path: string,
  issues: TaskPlanValidationIssue[],
  requireAuthorizedOutputs: boolean,
): value is DependencyTask => {
  if (!isRecord(value)) {
    pushIssue(issues, 'INVALID_SHAPE', path, '任务必须是对象。')
    return false
  }

  const validId = validateRequiredString(value.id, `${path}.id`, issues, { id: true })
  validateRequiredString(value.title, `${path}.title`, issues)
  validateRequiredString(value.description, `${path}.description`, issues)
  validateRequiredString(value.prompt, `${path}.prompt`, issues)
  const validDependencies = validateStringArray(value.dependsOn, `${path}.dependsOn`, issues, false)
  validateStringArray(value.expectedDeliverables, `${path}.expectedDeliverables`, issues, true)
  validateStringArray(value.acceptanceChecks, `${path}.acceptanceChecks`, issues, true)

  if (!isProviderId(value.recommendedProviderId)) {
    pushIssue(issues, 'INVALID_PROVIDER_ID', `${path}.recommendedProviderId`, 'Provider ID 不受支持。')
  }
  if (value.providerRecommendation !== undefined) {
    validateProviderRecommendation(value.providerRecommendation, `${path}.providerRecommendation`, issues)
  }
  if (typeof value.executionMode !== 'string' || !executionModes.has(value.executionMode)) {
    pushIssue(issues, 'INVALID_SHAPE', `${path}.executionMode`, '执行模式必须是 manual、api 或 local-agent。')
  }

  if (!isRecord(value.files)) {
    pushIssue(issues, 'INVALID_SHAPE', `${path}.files`, '文件范围必须是对象。')
  } else {
    validateInputFiles(value.files.inputs, `${path}.files.inputs`, issues)
    if (value.files.readPaths !== undefined) {
      validatePathArray(value.files.readPaths, `${path}.files.readPaths`, issues)
    }
    validatePathArray(value.files.allowedWritePaths, `${path}.files.allowedWritePaths`, issues)
    validatePathArray(value.files.forbiddenPaths, `${path}.files.forbiddenPaths`, issues)
    validatePathArray(value.files.outputPaths, `${path}.files.outputPaths`, issues)
    if (Array.isArray(value.files.inputs)
      && (value.files.readPaths === undefined || Array.isArray(value.files.readPaths))
      && Array.isArray(value.files.allowedWritePaths)
      && Array.isArray(value.files.forbiddenPaths)
      && Array.isArray(value.files.outputPaths)) {
      const scopeIssues = validateTaskPathScope(value.files as unknown as TaskNode['files'], { requireAuthorizedOutputs })
      scopeIssues.forEach(issue => pushIssue(issues, 'INVALID_PATH', `${path}.files.${issue.path}`, issue.message))
    }
  }

  return validId && validDependencies
}

const validateDependencies = (
  tasks: DependencyTask[],
  issues: TaskPlanValidationIssue[],
) => {
  const taskIds = new Set<string>()
  tasks.forEach((task, index) => {
    if (taskIds.has(task.id)) {
      pushIssue(issues, 'DUPLICATE_TASK_ID', `tasks[${index}].id`, `任务 ID “${task.id}” 重复。`)
    }
    taskIds.add(task.id)
  })

  tasks.forEach((task, taskIndex) => {
    const seenDependencies = new Set<string>()
    task.dependsOn.forEach((dependency, dependencyIndex) => {
      const path = `tasks[${taskIndex}].dependsOn[${dependencyIndex}]`
      if (seenDependencies.has(dependency)) {
        pushIssue(issues, 'DUPLICATE_DEPENDENCY', path, `依赖任务 “${dependency}” 重复。`)
      } else if (dependency === task.id) {
        pushIssue(issues, 'SELF_DEPENDENCY', path, '任务不能依赖自身。')
      } else if (!taskIds.has(dependency)) {
        pushIssue(issues, 'UNKNOWN_DEPENDENCY', path, `依赖任务 “${dependency}” 不存在。`)
      }
      seenDependencies.add(dependency)
    })
  })

  const taskById = new Map(tasks.map((task) => [task.id, task]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  let cycleFound = false

  const visit = (taskId: string) => {
    if (cycleFound || visited.has(taskId)) return
    if (visiting.has(taskId)) {
      cycleFound = true
      return
    }
    visiting.add(taskId)
    for (const dependency of taskById.get(taskId)?.dependsOn ?? []) {
      if (taskById.has(dependency)) visit(dependency)
    }
    visiting.delete(taskId)
    visited.add(taskId)
  }

  for (const task of tasks) visit(task.id)
  if (cycleFound) {
    pushIssue(issues, 'CYCLIC_DEPENDENCY', 'tasks', '任务依赖必须构成有向无环图。')
  }
}

export function validateTaskPlan(value: unknown): TaskPlanValidationResult {
  const issues: TaskPlanValidationIssue[] = []
  if (!isRecord(value)) {
    return {
      ok: false,
      issues: [{ code: 'INVALID_SHAPE', path: '$', message: '任务计划必须是对象。' }],
    }
  }

  if (value.schemaVersion !== 1) {
    pushIssue(issues, 'UNSUPPORTED_VERSION', 'schemaVersion', '仅支持任务计划版本 1。')
  }
  validateRequiredString(value.id, 'id', issues, { id: true })
  validateRequiredString(value.title, 'title', issues)
  validateRequiredString(value.goal, 'goal', issues)
  validateStringArray(value.assumptions, 'assumptions', issues, false)
  validateStringArray(value.finalAcceptanceChecks, 'finalAcceptanceChecks', issues, true)

  const hasWorkspace = value.workspace !== undefined
  if (hasWorkspace) {
    if (!isRecord(value.workspace)) {
      pushIssue(issues, 'INVALID_SHAPE', 'workspace', '工作区信息必须是对象。')
    } else {
      if (typeof value.workspace.id !== 'string' || !/^[0-9a-f]{64}$/.test(value.workspace.id)) {
        pushIssue(issues, 'INVALID_SHAPE', 'workspace.id', '工作区标识无效。')
      }
      validateRequiredString(value.workspace.displayName, 'workspace.displayName', issues)
      if (value.workspace.defaultScope !== undefined) {
        if (!isRecord(value.workspace.defaultScope)) {
          pushIssue(issues, 'INVALID_SHAPE', 'workspace.defaultScope', '工作区默认授权必须是对象。')
        } else {
          const defaultScope = value.workspace.defaultScope
          validatePathArray(defaultScope.readPaths, 'workspace.defaultScope.readPaths', issues)
          validatePathArray(defaultScope.allowedWritePaths, 'workspace.defaultScope.allowedWritePaths', issues)
          validatePathArray(defaultScope.forbiddenPaths, 'workspace.defaultScope.forbiddenPaths', issues)
          validatePathArray(defaultScope.outputPaths, 'workspace.defaultScope.outputPaths', issues)
          if (Array.isArray(defaultScope.readPaths)
            && Array.isArray(defaultScope.allowedWritePaths)
            && Array.isArray(defaultScope.forbiddenPaths)
            && Array.isArray(defaultScope.outputPaths)) {
            const scopeIssues = validateTaskPathScope({
              inputs: [],
              readPaths: defaultScope.readPaths as string[],
              allowedWritePaths: defaultScope.allowedWritePaths as string[],
              forbiddenPaths: defaultScope.forbiddenPaths as string[],
              outputPaths: defaultScope.outputPaths as string[],
            }, { requireAuthorizedOutputs: true })
            scopeIssues.forEach(issue => pushIssue(
              issues,
              'INVALID_PATH',
              `workspace.defaultScope.${issue.path}`,
              issue.message,
            ))
          }
        }
      }
    }
  }

  const validTasks: DependencyTask[] = []
  if (!Array.isArray(value.tasks)) {
    pushIssue(issues, 'INVALID_SHAPE', 'tasks', '任务列表必须是数组。')
  } else {
    if (value.tasks.length === 0) {
      pushIssue(issues, 'INVALID_SHAPE', 'tasks', '任务计划至少需要一个任务。')
    }
    if (value.tasks.length > MAX_TASK_PLAN_TASKS) {
      pushIssue(issues, 'LIMIT_EXCEEDED', 'tasks', `任务数量不能超过 ${MAX_TASK_PLAN_TASKS}。`)
    }
    value.tasks.forEach((task, index) => {
        if (validateTask(task, `tasks[${index}]`, issues, hasWorkspace)) validTasks.push(task)
    })
  }

  if (validTasks.length === (Array.isArray(value.tasks) ? value.tasks.length : -1)) {
    validateDependencies(validTasks, issues)
  }

  return issues.length === 0
    ? { ok: true, plan: value as unknown as TaskPlan }
    : { ok: false, issues }
}

export const isTaskPlan = (value: unknown): value is TaskPlan => validateTaskPlan(value).ok
