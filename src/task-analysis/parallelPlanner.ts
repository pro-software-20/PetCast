import type { TaskAnalysisInput } from '../types/taskAnalysis'

export interface ParallelPlanningResult {
  canRunInParallel: boolean
  parallelPlan: string[]
}

const sequentialDependencyPattern = /先[\s\S]{0,80}(?:再|然后)|完成后|基于前一步|然后|依赖|\bafter\b|\bbased on\b|\bdepends? on\b|\bdependent on\b/i
const independentMarkerPattern = /并行|分别|各自|互不依赖|独立任务|parallel|independent|separately/i
const numberedTaskPattern = /^\s*(?:\d+[.)]|[一二三四五六七八九十]+[、.)])\s*(.+?)\s*$/
const independentDependencyPattern = /互不依赖|不依赖|无需依赖|无依赖|\bindependent\b|\bwithout dependenc(?:y|ies)\b/gi

const extractTaskFragments = (prompt: string) => {
  const numberedTasks = prompt
    .split(/\r?\n/)
    .map((line) => line.match(numberedTaskPattern)?.[1]?.trim())
    .filter((task): task is string => Boolean(task))

  if (numberedTasks.length >= 2) return numberedTasks

  return prompt
    .split(/\r?\n|[；;]|并且|同时|以及|和|及|\band\b|\balso\b/i)
    .map((fragment) => fragment.trim())
    .filter((fragment) => fragment.length > 0)
}

export function planParallelTasks(input: TaskAnalysisInput): ParallelPlanningResult {
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
  const fragments = extractTaskFragments(prompt)
  const dependencyText = prompt.replace(independentDependencyPattern, '')
  const hasSequentialDependency = sequentialDependencyPattern.test(dependencyText)
  const hasNumberedTasks = fragments.length >= 2 && prompt.split(/\r?\n/).filter((line) => numberedTaskPattern.test(line)).length >= 2
  const hasExplicitIndependentTasks = independentMarkerPattern.test(prompt) && fragments.length >= 2
  const canRunInParallel = !hasSequentialDependency && (hasNumberedTasks || hasExplicitIndependentTasks)

  if (canRunInParallel) {
    const visibleTasks = fragments.slice(0, 3).join('；')
    return {
      canRunInParallel: true,
      parallelPlan: [
        `可并行处理以下独立任务：${visibleTasks}`,
        '各子任务完成后统一汇总结果。',
        '最后进行一致性检查和整体验证。',
      ],
    }
  }

  if (hasSequentialDependency) {
    return {
      canRunInParallel: false,
      parallelPlan: [
        '检测到任务之间存在先后依赖，建议按依赖顺序串行执行。',
        '完成前一步后再开始下一步，最后统一验证。',
      ],
    }
  }

  return {
    canRunInParallel: false,
    parallelPlan: [
      '未检测到明确的相互独立任务，建议先按原 Prompt 串行执行。',
      '执行过程中确认依赖关系后，再决定是否拆分任务。',
    ],
  }
}
