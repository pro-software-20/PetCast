import type { TaskNode, TaskPlan, TaskPriority, TaskSessionV1, TaskStatus } from '../types/taskOrchestration'

export const DEFAULT_TASK_PRIORITY: TaskPriority = 'medium'

const priorityWeights: Record<TaskPriority, number> = {
  high: 3,
  medium: 2,
  low: 1,
}

export const getTaskPriority = (task: Pick<TaskNode, 'priority'>): TaskPriority => (
  task.priority ?? DEFAULT_TASK_PRIORITY
)

/** Normalizes newly received plans without changing IDs, dependencies, or runtime state. */
export const withDefaultTaskPriorities = (plan: TaskPlan): TaskPlan => ({
  ...plan,
  tasks: plan.tasks.map(task => ({ ...task, priority: getTaskPriority(task) })),
})

export const priorityLabel = (priority: TaskPriority) => ({
  high: '\u9ad8\u4f18\u5148\u7ea7',
  medium: '\u4e2d\u4f18\u5148\u7ea7',
  low: '\u4f4e\u4f18\u5148\u7ea7',
}[priority])

export interface TaskSchedulingInsight {
  taskId: string
  priority: TaskPriority
  /** Number of nodes this task can unlock along its longest downstream chain. */
  criticalPathScore: number
  isCriticalPath: boolean
  status: TaskStatus
  blockedByTaskIds: string[]
  parallelReadyCount: number
  suggestedOrder?: number
  reasons: string[]
}

export interface TaskSchedulingAnalysis {
  insights: TaskSchedulingInsight[]
  orderedReadyTaskIds: string[]
  runnableTaskIds: string[]
  criticalPathTaskIds: string[]
  waitingTaskIds: string[]
}

const rank = (left: TaskSchedulingInsight, right: TaskSchedulingInsight, indexes: Map<string, number>) => (
  priorityWeights[right.priority] - priorityWeights[left.priority]
  || right.criticalPathScore - left.criticalPathScore
  || (indexes.get(left.taskId) ?? Number.MAX_SAFE_INTEGER) - (indexes.get(right.taskId) ?? Number.MAX_SAFE_INTEGER)
)

/**
 * Derives scheduling information from the current DAG and run states. Nothing
 * here is persisted, so dependency or priority edits are reflected immediately.
 */
export function analyzeTaskScheduling(session: TaskSessionV1): TaskSchedulingAnalysis {
  const taskById = new Map(session.plan.tasks.map(task => [task.id, task]))
  const runById = new Map(session.runs.map(run => [run.taskId, run]))
  const indexes = new Map(session.plan.tasks.map((task, index) => [task.id, index]))
  const dependents = new Map(session.plan.tasks.map(task => [task.id, [] as string[]]))
  for (const task of session.plan.tasks) {
    for (const dependencyId of task.dependsOn) {
      if (taskById.has(dependencyId)) dependents.get(dependencyId)?.push(task.id)
    }
  }

  // Longest route from a node to a leaf. This is the deterministic score used
  // as the second scheduling key after explicit user priority.
  const downstreamScores = new Map<string, number>()
  const downstreamVisiting = new Set<string>()
  const downstreamScoreFor = (taskId: string): number => {
    const existing = downstreamScores.get(taskId)
    if (existing !== undefined) return existing
    if (downstreamVisiting.has(taskId)) return 1
    downstreamVisiting.add(taskId)
    const children = dependents.get(taskId) ?? []
    const score = 1 + (children.length ? Math.max(...children.map(downstreamScoreFor)) : 0)
    downstreamVisiting.delete(taskId)
    downstreamScores.set(taskId, score)
    return score
  }

  // Longest route from a root to a node. Combining this with the downstream
  // score identifies every node that belongs to a longest dependency path.
  const upstreamScores = new Map<string, number>()
  const upstreamVisiting = new Set<string>()
  const upstreamScoreFor = (taskId: string): number => {
    const existing = upstreamScores.get(taskId)
    if (existing !== undefined) return existing
    if (upstreamVisiting.has(taskId)) return 1
    upstreamVisiting.add(taskId)
    const task = taskById.get(taskId)
    const parents = task?.dependsOn.filter(parentId => taskById.has(parentId)) ?? []
    const score = 1 + (parents.length ? Math.max(...parents.map(upstreamScoreFor)) : 0)
    upstreamVisiting.delete(taskId)
    upstreamScores.set(taskId, score)
    return score
  }

  const readyTaskIds = session.runs
    .filter(run => run.status === 'ready')
    .map(run => run.taskId)
  const longestPathLength = Math.max(
    0,
    ...session.plan.tasks.map(task => upstreamScoreFor(task.id) + downstreamScoreFor(task.id) - 1),
  )

  const insights = session.plan.tasks.map((task): TaskSchedulingInsight => {
    const run = runById.get(task.id)
    const status = run?.status ?? 'waiting'
    const blockedByTaskIds = task.dependsOn.filter(dependencyId => runById.get(dependencyId)?.status !== 'done')
    const priority = getTaskPriority(task)
    const criticalPathScore = downstreamScoreFor(task.id)
    const isCriticalPath = longestPathLength > 0
      && upstreamScoreFor(task.id) + criticalPathScore - 1 === longestPathLength
    const reasons = [priorityLabel(priority)]
    if (isCriticalPath) reasons.push('\u5173\u952e\u8def\u5f84\u4efb\u52a1')
    if (status === 'ready') {
      reasons.push(readyTaskIds.length > 1
        ? `\u53ef\u4e0e ${readyTaskIds.length - 1} \u4e2a\u4efb\u52a1\u5e76\u884c`
        : '\u5f53\u524d\u53ef\u6267\u884c')
    } else if (blockedByTaskIds.length > 0) {
      reasons.push(`\u7b49\u5f85\u524d\u7f6e\u4efb\u52a1\uff1a${blockedByTaskIds.join('\u3001')}`)
    }
    return {
      taskId: task.id,
      priority,
      criticalPathScore,
      isCriticalPath,
      status,
      blockedByTaskIds,
      parallelReadyCount: status === 'ready' ? Math.max(0, readyTaskIds.length - 1) : 0,
      reasons,
    }
  })

  const readyInsights = insights
    .filter(insight => insight.status === 'ready')
    .sort((left, right) => rank(left, right, indexes))
    .map((insight, index) => ({ ...insight, suggestedOrder: index + 1 }))
  const orderedById = new Map(readyInsights.map(insight => [insight.taskId, insight]))

  return {
    insights: insights.map(insight => orderedById.get(insight.taskId) ?? insight),
    orderedReadyTaskIds: readyInsights.map(insight => insight.taskId),
    runnableTaskIds: readyInsights.map(insight => insight.taskId),
    criticalPathTaskIds: insights.filter(insight => insight.isCriticalPath).map(insight => insight.taskId),
    waitingTaskIds: insights.filter(insight => insight.status === 'waiting').map(insight => insight.taskId),
  }
}

export function orderTasksForDispatch(session: TaskSessionV1): TaskNode[] {
  const taskById = new Map(session.plan.tasks.map(task => [task.id, task]))
  return analyzeTaskScheduling(session).orderedReadyTaskIds
    .map(taskId => taskById.get(taskId))
    .filter((task): task is TaskNode => Boolean(task))
}
