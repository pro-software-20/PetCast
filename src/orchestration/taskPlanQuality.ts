import type { BrainPlanningInput } from './BrainProvider'
import { recommendTaskProvider } from './taskRecommendation'
import type { TaskPlan } from '../types/taskOrchestration'

export type TaskPlanQualityIssueCode =
  | 'OVER_FRAGMENTED'
  | 'VAGUE_TASK'
  | 'MEANINGLESS_SERIALIZATION'
  | 'MISSING_ACCEPTANCE'
  | 'UNAVAILABLE_PROVIDER'

export interface TaskPlanQualityIssue {
  code: TaskPlanQualityIssueCode
  taskId?: string
  message: string
}

const vagueTitlePattern = /^(?:处理任务|执行任务|完成任务|后续处理|总结|其他|task|work|todo)$/i

/**
 * Treats model-selected worker providers as suggestions only. The existing local
 * recommender remains the authority for worker capabilities and display reasons.
 */
export function refreshTaskPlanRecommendations(
  plan: TaskPlan,
  input: BrainPlanningInput,
): TaskPlan {
  return {
    ...plan,
    assumptions: [...plan.assumptions],
    tasks: plan.tasks.map(task => {
      const selected = recommendTaskProvider({
        title: task.title,
        description: task.description,
        prompt: task.prompt,
        globalTaskType: input.analysisResult.taskType,
        files: task.files.inputs,
        availableProviders: input.availableProviders,
      })
      return {
        ...task,
        dependsOn: [...task.dependsOn],
        recommendedProviderId: selected.recommendedProviderId,
        providerRecommendation: {
          ...selected.recommendation,
          requiredCapabilities: [...selected.recommendation.requiredCapabilities],
        },
        files: {
          inputs: task.files.inputs.map(file => ({ ...file })),
          readPaths: [...(task.files.readPaths ?? [])],
          allowedWritePaths: [...task.files.allowedWritePaths],
          forbiddenPaths: [...task.files.forbiddenPaths],
          outputPaths: [...task.files.outputPaths],
        },
        expectedDeliverables: [...task.expectedDeliverables],
        acceptanceChecks: [...task.acceptanceChecks],
      }
    }),
    finalAcceptanceChecks: [...plan.finalAcceptanceChecks],
  }
}

/** Lightweight diagnostics for live acceptance reports and regression tests. */
export function inspectTaskPlanQuality(
  plan: TaskPlan,
  input: BrainPlanningInput,
): TaskPlanQualityIssue[] {
  const issues: TaskPlanQualityIssue[] = []
  const providers = new Set(input.availableProviders.map(provider => provider.id))

  if (plan.tasks.length > 12) {
    issues.push({
      code: 'OVER_FRAGMENTED',
      message: `任务方案包含 ${plan.tasks.length} 个子任务，可能存在过度拆分。`,
    })
  }

  for (const task of plan.tasks) {
    const combined = `${task.title}${task.description}${task.prompt}`.replace(/\s/g, '')
    if (vagueTitlePattern.test(task.title.trim()) || combined.length < 24) {
      issues.push({
        code: 'VAGUE_TASK',
        taskId: task.id,
        message: '任务目标过于空泛，缺少可执行上下文。',
      })
    }
    if (task.acceptanceChecks.length === 0 || task.acceptanceChecks.some(item => !item.trim())) {
      issues.push({
        code: 'MISSING_ACCEPTANCE',
        taskId: task.id,
        message: '任务缺少可人工判断的验收标准。',
      })
    }
    if (!providers.has(task.recommendedProviderId)) {
      issues.push({
        code: 'UNAVAILABLE_PROVIDER',
        taskId: task.id,
        message: '任务推荐了当前不可用的执行 Provider。',
      })
    }
  }

  const serializedChain = plan.tasks.length > 2 && plan.tasks.every((task, index) => (
    index === 0 ? task.dependsOn.length === 0 : (
      task.dependsOn.length === 1 && task.dependsOn[0] === plan.tasks[index - 1].id
    )
  ))
  if (input.analysisResult.canRunInParallel && serializedChain) {
    issues.push({
      code: 'MEANINGLESS_SERIALIZATION',
      message: '本地分析认为任务可并行，但远程方案把所有任务机械串行。',
    })
  }

  return issues
}
