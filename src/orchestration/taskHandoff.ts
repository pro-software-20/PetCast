import { normalizeWorkspacePath, pathContains } from './taskPathScope'
import type {
  ProviderId,
  TaskDependencyHandoffReceipt,
  TaskExecutionResult,
  TaskFileScope,
  TaskHandoffPackage,
  TaskRunRecord,
  TaskSessionV1,
  WorkspacePathScope,
} from '../types/taskOrchestration'

export interface DependencyHandoffArtifact {
  dependencyTaskId: string
  dependencyTitle: string
  path: string
  description: string
}

const uniqueStrings = (values: string[]) => [...new Set(values.map(value => value.trim()).filter(Boolean))]

export const createTaskHandoffPackage = (
  summary: string,
  changedFiles: string[],
): TaskHandoffPackage => ({
  summary: summary.trim(),
  keyDecisions: [],
  artifacts: uniqueStrings(changedFiles).flatMap((path) => {
    const normalized = normalizeWorkspacePath(path)
    return normalized ? [{ path: normalized, description: '前置任务生成或修改的文件。' }] : []
  }),
  openQuestions: [],
})

export const normalizeTaskHandoffPackage = (handoff: TaskHandoffPackage): TaskHandoffPackage => {
  const artifacts = new Map<string, string>()
  for (const artifact of handoff.artifacts) {
    const path = normalizeWorkspacePath(artifact.path)
    if (path && !artifacts.has(path)) artifacts.set(path, artifact.description.trim())
  }
  return {
    summary: handoff.summary.trim(),
    keyDecisions: uniqueStrings(handoff.keyDecisions),
    artifacts: [...artifacts].map(([path, description]) => ({
      path,
      description: description || '前置任务生成或修改的文件。',
    })),
    openQuestions: uniqueStrings(handoff.openQuestions),
  }
}

export const getDependencyHandoffArtifacts = (
  session: TaskSessionV1,
  taskId: string,
): DependencyHandoffArtifact[] => {
  const task = session.plan.tasks.find(candidate => candidate.id === taskId)
  if (!task) return []
  return task.dependsOn.flatMap((dependencyTaskId) => {
    const dependencyTask = session.plan.tasks.find(candidate => candidate.id === dependencyTaskId)
    const result = session.runs.find(candidate => candidate.taskId === dependencyTaskId)?.result
    return result?.handoff?.artifacts.map(artifact => ({
      dependencyTaskId,
      dependencyTitle: dependencyTask?.title ?? dependencyTaskId,
      path: artifact.path,
      description: artifact.description,
    })) ?? []
  })
}

const pathIsForbidden = (path: string, scope: TaskFileScope) => (
  scope.forbiddenPaths.some(forbidden => pathContains(forbidden, path))
)

export const taskScopeCanRead = (path: string, scope: TaskFileScope, extraReadPaths: string[] = []) => {
  if (pathIsForbidden(path, scope)) return false
  return [
    ...(scope.readPaths ?? []),
    ...scope.allowedWritePaths,
    ...scope.outputPaths,
    ...extraReadPaths,
  ].some(allowed => pathContains(allowed, path))
}

export const getHandoffReceipt = (
  run: TaskRunRecord,
  dependencyTaskId: string,
): TaskDependencyHandoffReceipt | undefined => (
  run.dependencyHandoffs?.find(receipt => receipt.dependencyTaskId === dependencyTaskId)
)

export const getHandoffReadiness = (
  session: TaskSessionV1,
  taskId: string,
  mode: 'manual' | 'local-agent',
  providerId?: ProviderId,
) => {
  const task = session.plan.tasks.find(candidate => candidate.id === taskId)
  const run = session.runs.find(candidate => candidate.taskId === taskId)
  const artifacts = getDependencyHandoffArtifacts(session, taskId)
  if (!task || !run) return { ready: false, artifacts, missing: artifacts }
  const missing = artifacts.filter((artifact) => {
    const receipt = getHandoffReceipt(run, artifact.dependencyTaskId)
    if (mode === 'manual') {
      return receipt?.providedToProviderId !== (providerId ?? run.assignedProviderId)
        || !receipt.providedArtifactPaths.includes(artifact.path)
    }
    return !taskScopeCanRead(artifact.path, task.files, receipt?.authorizedReadPaths ?? [])
  })
  return { ready: missing.length === 0, artifacts, missing }
}

export const getEffectiveTaskWorkspaceScope = (
  taskFiles: TaskFileScope,
  run: TaskRunRecord,
): WorkspacePathScope => ({
  readPaths: uniqueStrings([
    ...(taskFiles.readPaths ?? []),
    ...(run.dependencyHandoffs?.flatMap(receipt => receipt.authorizedReadPaths) ?? []),
  ]),
  allowedWritePaths: [...taskFiles.allowedWritePaths],
  forbiddenPaths: [...taskFiles.forbiddenPaths],
  outputPaths: [...taskFiles.outputPaths],
})

export const dependencyResultHasArtifact = (
  result: TaskExecutionResult | undefined,
  path: string,
) => result?.handoff?.artifacts.some(artifact => artifact.path === path) ?? false
