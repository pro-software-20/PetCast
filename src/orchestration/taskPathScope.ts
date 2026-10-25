import type { TaskFileScope, WorkspacePathScope } from '../types/taskOrchestration'

export const MAX_TASK_SCOPE_PATHS = 200

export interface TaskPathScopeIssue {
  path: string
  message: string
}

export const normalizeWorkspacePath = (value: string): string | null => {
  const normalized = value.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\.\//, '')
  if (!normalized || normalized === '.' || normalized.includes('\0')) return null
  if (normalized.includes(':') || normalized.startsWith('/')) return null
  const segments = normalized.split('/')
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) return null
  return normalized
}

export const pathContains = (parent: string, child: string) => (
  parent === child || child.startsWith(`${parent}/`)
)

const normalizePathList = (paths: string[] = []) => {
  const result: string[] = []
  for (const path of paths) {
    const normalized = normalizeWorkspacePath(path)
    if (normalized && !result.includes(normalized)) result.push(normalized)
  }
  return result
}

export const normalizeTaskFileScope = (scope: TaskFileScope): TaskFileScope => {
  const inputs: TaskFileScope['inputs'] = []
  const legacyWorkspaceInputs: string[] = []
  for (const input of scope.inputs) {
    if (input.kind === 'attachment') {
      inputs.push({ ...input })
      continue
    }
    const normalized = normalizeWorkspacePath(input.path)
    if (normalized) legacyWorkspaceInputs.push(normalized)
  }

  return {
    inputs,
    readPaths: normalizePathList([...(scope.readPaths ?? []), ...legacyWorkspaceInputs]),
    allowedWritePaths: normalizePathList(scope.allowedWritePaths),
    forbiddenPaths: normalizePathList(scope.forbiddenPaths),
    outputPaths: normalizePathList(scope.outputPaths),
  }
}

export const normalizeWorkspacePathScope = (scope: WorkspacePathScope): WorkspacePathScope => ({
  readPaths: normalizePathList(scope.readPaths),
  allowedWritePaths: normalizePathList(scope.allowedWritePaths),
  forbiddenPaths: normalizePathList(scope.forbiddenPaths),
  outputPaths: normalizePathList(scope.outputPaths),
})

export const getTaskWorkspacePathScope = (scope: TaskFileScope): WorkspacePathScope => (
  normalizeWorkspacePathScope({
    readPaths: [
      ...(scope.readPaths ?? []),
      ...scope.inputs.flatMap(input => input.kind === 'workspace' ? [input.path] : []),
    ],
    allowedWritePaths: scope.allowedWritePaths,
    forbiddenPaths: scope.forbiddenPaths,
    outputPaths: scope.outputPaths,
  })
)

export const applyWorkspacePathScope = (
  current: TaskFileScope,
  workspaceScope: WorkspacePathScope,
): TaskFileScope => {
  const normalized = normalizeWorkspacePathScope(workspaceScope)
  return {
    inputs: current.inputs.filter(input => input.kind === 'attachment').map(input => ({ ...input })),
    readPaths: normalized.readPaths,
    allowedWritePaths: normalized.allowedWritePaths,
    forbiddenPaths: normalized.forbiddenPaths,
    outputPaths: normalized.outputPaths,
  }
}

export const workspacePathScopesEqual = (
  left: WorkspacePathScope,
  right: WorkspacePathScope,
) => JSON.stringify(normalizeWorkspacePathScope(left)) === JSON.stringify(normalizeWorkspacePathScope(right))

export function validateTaskPathScope(
  scope: TaskFileScope,
  options: { requireAuthorizedOutputs?: boolean } = {},
): TaskPathScopeIssue[] {
  const issues: TaskPathScopeIssue[] = []
  const lists = [
    ['readPaths', scope.readPaths ?? []],
    ['allowedWritePaths', scope.allowedWritePaths],
    ['forbiddenPaths', scope.forbiddenPaths],
    ['outputPaths', scope.outputPaths],
  ] as const

  for (const [name, paths] of lists) {
    if (paths.length > MAX_TASK_SCOPE_PATHS) {
      issues.push({ path: name, message: `路径数量不能超过 ${MAX_TASK_SCOPE_PATHS} 项。` })
    }
    const seen = new Set<string>()
    paths.forEach((candidate, index) => {
      const normalized = normalizeWorkspacePath(candidate)
      if (!normalized || normalized !== candidate) {
        issues.push({ path: `${name}[${index}]`, message: '必须是规范、安全的工作区相对路径。' })
      } else if (seen.has(candidate)) {
        issues.push({ path: `${name}[${index}]`, message: '路径不能重复。' })
      }
      seen.add(candidate)
    })
  }

  const workspaceInputs = scope.inputs.filter(input => input.kind === 'workspace')
  if (workspaceInputs.length > MAX_TASK_SCOPE_PATHS) {
    issues.push({ path: 'inputs', message: `工作区输入不能超过 ${MAX_TASK_SCOPE_PATHS} 项。` })
  }
  const inputPaths = new Set<string>()
  workspaceInputs.forEach((input, index) => {
    const normalized = normalizeWorkspacePath(input.path)
    if (!normalized || normalized !== input.path) {
      issues.push({ path: `inputs[${index}].path`, message: '必须是规范、安全的工作区相对路径。' })
    } else if (inputPaths.has(input.path)) {
      issues.push({ path: `inputs[${index}].path`, message: '工作区输入不能重复。' })
    }
    inputPaths.add(input.path)
  })

  scope.allowedWritePaths.forEach((allowed, index) => {
    if (scope.forbiddenPaths.includes(allowed)) {
      issues.push({ path: `allowedWritePaths[${index}]`, message: '同一路径不能同时允许和禁止修改。' })
    }
  })

  if (options.requireAuthorizedOutputs) {
    scope.outputPaths.forEach((output, index) => {
      if (!scope.allowedWritePaths.some(allowed => pathContains(allowed, output))) {
        issues.push({ path: `outputPaths[${index}]`, message: '输出位置必须位于允许修改范围内。' })
      } else if (scope.forbiddenPaths.some(forbidden => pathContains(forbidden, output))) {
        issues.push({ path: `outputPaths[${index}]`, message: '输出位置不能位于禁止修改范围内。' })
      }
    })
  }

  return issues
}
