import type { BrainPlanningInput, BrainPlanningOutcome, BrainProvider } from './BrainProvider'
import { validateTaskPlan } from './taskPlanValidation'
import { LOCAL_PROVIDER_PROFILE } from './providerProfiles'
import { recommendTaskProvider } from './taskRecommendation'
import type {
  ProviderProfile,
  TaskInputFileReference,
  TaskNode,
  TaskPlan,
  TaskWorkCategory,
} from '../types/taskOrchestration'

interface TaskDraft {
  title: string
  description: string
  prompt: string
  categoryHint?: TaskWorkCategory
  expectedDeliverables: string[]
  acceptanceChecks: string[]
}

const numberedTaskPattern = /^\s*(?:\d+[.)]|[一二三四五六七八九十]+[、.)])\s*(.+?)\s*$/
const explicitParallelPattern = /并行|同时|分别|各自|独立|互不依赖|\bparallel\b|\bindependent(?:ly)?\b/i
const previousStepPattern = /完成后|完成(?:前一|上一个)任务后|基于前一步|基于上一步|然后|随后|接着|再(?:完成|进行|执行|实现|编写|撰写|测试|验证)|依赖前一步|依赖上一步|\bafter\b|\bbased on (?:the )?(?:previous|prior) step\b|\bthen\b|\bnext\b/i
const referencedTaskPattern = /(?:任务|步骤)\s*#?\s*(\d+)|\b(?:task|step)\s*#?\s*(\d+)\b/gi

const normalizePrompt = (prompt: string) => prompt.trim().replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n')

const extractNumberedTasks = (prompt: string) => prompt
  .split(/\r?\n/)
  .map((line) => line.match(numberedTaskPattern)?.[1]?.trim())
  .filter((fragment): fragment is string => Boolean(fragment))

const dependenciesForNumberedTask = (fragment: string, index: number): string[] => {
  if (index === 0) return []

  const referencedIndexes = [...fragment.matchAll(referencedTaskPattern)]
    .map(match => Number(match[1] ?? match[2]) - 1)
    .filter(referencedIndex => Number.isInteger(referencedIndex) && referencedIndex >= 0 && referencedIndex < index)
  const explicitDependencies = [...new Set(referencedIndexes.map(referencedIndex => `task-${referencedIndex + 1}`))]
  if (explicitDependencies.length > 0) return explicitDependencies
  if (explicitParallelPattern.test(fragment)) return []
  return previousStepPattern.test(fragment) ? [`task-${index}`] : []
}

const hashText = (text: string) => {
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

const shortTitle = (text: string, fallback: string) => {
  const normalized = text.replace(/[。！？.!?]+$/g, '').trim()
  if (!normalized) return fallback
  return normalized.length > 28 ? `${normalized.slice(0, 28)}…` : normalized
}

const genericDraft = (text: string): TaskDraft => {
  return {
    title: shortTitle(text, '完成用户任务'),
    description: `独立完成以下任务：${text}`,
    prompt: text,
    expectedDeliverables: ['与任务目标一致的完整结果'],
    acceptanceChecks: ['结果覆盖任务要求，并明确说明限制和验证方式'],
  }
}

const templateDrafts = (taskType: string, goal: string, optimizedPrompt: string): TaskDraft[] => {
  if (taskType === 'coding') return [
    {
      title: '确认范围与实现方案',
      description: '梳理技术环境、修改范围、依赖关系和风险。',
      prompt: `围绕“${goal}”确认需求与约束，提出最小可行实现方案。`,
      categoryHint: 'planning',
      expectedDeliverables: ['实现方案和文件影响范围'],
      acceptanceChecks: ['方案不扩大原任务范围，并列出待确认信息'],
    },
    {
      title: '完成代码实现',
      description: '按照已确认方案完成最小范围的代码修改。',
      prompt: `根据前一步方案实现“${goal}”，严格遵守文件权限并记录实际修改。`,
      categoryHint: 'coding',
      expectedDeliverables: ['代码修改或可审查的补丁', '修改文件说明'],
      acceptanceChecks: ['修改与方案一致', '没有改动未授权文件'],
    },
    {
      title: '验证实现结果',
      description: '检查类型、构建、测试和任务验收条件。',
      prompt: `验证“${goal}”的实现结果，报告实际运行的检查、失败项和剩余风险。`,
      categoryHint: 'testing',
      expectedDeliverables: ['验证记录和问题清单'],
      acceptanceChecks: ['不声称执行未实际运行的检查', '失败信息可复现'],
    },
  ]

  if (taskType === 'research') return [
    {
      title: '明确研究问题与资料标准',
      description: '确定研究范围、时间边界和可信来源要求。',
      prompt: `围绕“${goal}”明确研究问题、范围、关键词和来源标准。`,
      categoryHint: 'planning',
      expectedDeliverables: ['研究问题和检索方案'],
      acceptanceChecks: ['范围清晰且资料标准可执行'],
    },
    {
      title: '检索并分析资料',
      description: '按既定标准整理事实、证据和不确定信息。',
      prompt: `按照前一步标准研究“${goal}”，区分事实、推断和待验证信息。`,
      categoryHint: 'research',
      expectedDeliverables: ['带来源线索的资料分析'],
      acceptanceChecks: ['不虚构来源', '关键信息可以复核'],
    },
    {
      title: '汇总结论并核验',
      description: '整合研究结果，检查证据是否支持结论。',
      prompt: `汇总“${goal}”的研究结果，指出证据不足、冲突信息和复核方法。`,
      categoryHint: 'review',
      expectedDeliverables: ['研究结论和局限说明'],
      acceptanceChecks: ['结论与证据对应', '明确说明未知信息'],
    },
  ]

  if (taskType === 'writing') return [
    {
      title: '确认写作要求与提纲',
      description: '明确受众、篇幅、语气、资料要求和文章结构。',
      prompt: `针对“${goal}”确认写作要求并生成结构清晰的提纲。`,
      categoryHint: 'planning',
      expectedDeliverables: ['写作要求清单和提纲'],
      acceptanceChecks: ['提纲覆盖原始目标', '缺失信息被明确列出'],
    },
    {
      title: '按提纲撰写内容',
      description: '根据已确认的结构和要求完成正文。',
      prompt: `根据前一步提纲撰写“${goal}”相关内容，不虚构事实、数据或引用。`,
      categoryHint: 'writing',
      expectedDeliverables: ['符合提纲的完整稿件'],
      acceptanceChecks: ['结构完整', '表达符合目标读者和语气'],
    },
    {
      title: '核查与润色',
      description: '检查逻辑、事实、引用风险和语言质量。',
      prompt: `复核并润色“${goal}”的稿件，列出事实或引用仍需人工确认的部分。`,
      categoryHint: 'review',
      expectedDeliverables: ['润色稿和核查说明'],
      acceptanceChecks: ['不新增未经证实的事实', '问题和修改清晰可追踪'],
    },
  ]

  if (taskType === 'testing') return [
    {
      title: '设计测试方案',
      description: '明确测试对象、环境、场景和验收标准。',
      prompt: `为“${goal}”设计覆盖正常、边界和失败场景的测试方案。`,
      categoryHint: 'testing',
      expectedDeliverables: ['测试场景和预期结果'],
      acceptanceChecks: ['覆盖关键路径和异常情况'],
    },
    {
      title: '执行测试并记录结果',
      description: '按照测试方案执行检查并记录可复现结果。',
      prompt: `按照前一步测试方案验证“${goal}”，记录实际结果、失败原因和复现方式。`,
      categoryHint: 'testing',
      expectedDeliverables: ['测试结果和缺陷记录'],
      acceptanceChecks: ['执行结果与预期逐项对应', '未执行项明确标记'],
    },
  ]

  if (taskType === 'mixed') return [
    {
      title: '拆分目标并确认依赖',
      description: '识别不同目标、执行顺序和需要补充的信息。',
      prompt: `分析“${goal}”中的不同目标，明确范围、依赖和执行顺序。`,
      categoryHint: 'planning',
      expectedDeliverables: ['目标与依赖清单'],
      acceptanceChecks: ['各目标边界清楚且没有遗漏主要需求'],
    },
    {
      title: '执行主要任务',
      description: '按照已确认的范围完成主要交付内容。',
      prompt: `根据前一步拆分结果完成“${goal}”的主要任务，并记录限制。`,
      expectedDeliverables: ['主要任务结果'],
      acceptanceChecks: ['结果与拆分后的目标一致'],
    },
    {
      title: '汇总并整体验证',
      description: '整合所有结果并检查一致性和完成情况。',
      prompt: `汇总“${goal}”的各部分结果，检查冲突、遗漏和验收条件。`,
      categoryHint: 'review',
      expectedDeliverables: ['汇总结果和未解决问题'],
      acceptanceChecks: ['各部分结果一致', '未解决问题明确列出'],
    },
  ]

  return [{
    ...genericDraft(optimizedPrompt),
    title: taskType === 'analysis' ? '完成分析任务' : '完成用户任务',
    description: taskType === 'analysis' ? '根据现有信息完成分析并说明依据。' : '按照优化后的要求完成任务。',
  }]
}

const toAttachments = (files: BrainPlanningInput['analysisInput']['files']): TaskInputFileReference[] => files.map((file) => ({
  kind: 'attachment',
  name: file.name,
  type: file.type,
  size: file.size,
}))

const createTaskNode = (
  draft: TaskDraft,
  index: number,
  dependsOn: string[],
  providers: ProviderProfile[],
  inputs: TaskInputFileReference[],
  taskType: string,
): TaskNode => {
  const selected = recommendTaskProvider({
    title: draft.title,
    description: draft.description,
    prompt: draft.prompt,
    globalTaskType: taskType,
    files: inputs,
    availableProviders: providers,
    categoryHint: draft.categoryHint,
  })
  return {
    id: `task-${index + 1}`,
    title: draft.title,
    description: draft.description,
    dependsOn,
    recommendedProviderId: selected.recommendedProviderId,
    providerRecommendation: selected.recommendation,
    executionMode: 'manual',
    prompt: draft.prompt,
    files: {
      inputs: inputs.map((input) => ({ ...input })),
      allowedWritePaths: [],
      forbiddenPaths: [],
      outputPaths: [],
    },
    expectedDeliverables: [...draft.expectedDeliverables],
    acceptanceChecks: [...draft.acceptanceChecks],
  }
}

const isPlanningInput = (input: BrainPlanningInput) => Boolean(
  input
  && input.analysisInput
  && typeof input.analysisInput.prompt === 'string'
  && Array.isArray(input.analysisInput.files)
  && input.analysisResult
  && typeof input.analysisResult.taskType === 'string'
  && typeof input.analysisResult.optimizedPrompt === 'string'
  && Array.isArray(input.availableProviders),
)

export class LocalBrainProvider implements BrainProvider {
  readonly profile = LOCAL_PROVIDER_PROFILE

  async createPlan(input: BrainPlanningInput, signal?: AbortSignal): Promise<BrainPlanningOutcome> {
    if (signal?.aborted) return { ok: false, code: 'CANCELLED', message: '任务拆解已取消。' }
    if (!isPlanningInput(input)) return { ok: false, code: 'INVALID_INPUT', message: '任务拆解输入无效。' }

    try {
      const prompt = normalizePrompt(input.analysisInput.prompt)
      const goal = prompt || `根据 ${input.analysisInput.files.length} 个附件的元信息明确并完成任务`
      const fragments = extractNumberedTasks(prompt)
      const drafts = fragments.length >= 2
        ? fragments.map((fragment) => genericDraft(fragment))
        : templateDrafts(input.analysisResult.taskType, goal, input.analysisResult.optimizedPrompt)
      const attachments = toAttachments(input.analysisInput.files)
      const tasks = drafts.map((draft, index) => createTaskNode(
        draft,
        index,
        fragments.length >= 2
          ? dependenciesForNumberedTask(fragments[index], index)
          : (index === 0 ? [] : [`task-${index}`]),
        input.availableProviders,
        attachments,
        input.analysisResult.taskType,
      ))

      const plan: TaskPlan = {
        schemaVersion: 1,
        id: `local-plan-${hashText(`${goal}\0${input.analysisResult.taskType}`)}`,
        title: `任务方案：${shortTitle(goal, '附件任务')}`,
        goal,
        assumptions: [...new Set([
          ...input.analysisResult.assumptions,
          '当前方案由本地规则生成，任务将由用户人工复制给所选 AI。',
          '附件仅包含名称、类型和大小，未读取文件内容。',
        ])],
        tasks,
        finalAcceptanceChecks: [
          '逐项确认所有子任务的交付物和验收标准。',
          '汇总结果时检查依赖、冲突、遗漏和仍需人工确认的信息。',
        ],
      }

      if (signal?.aborted) return { ok: false, code: 'CANCELLED', message: '任务拆解已取消。' }
      const validation = validateTaskPlan(plan)
      if (!validation.ok) {
        return { ok: false, code: 'INVALID_RESPONSE', message: '本地任务方案未通过安全校验。' }
      }
      return { ok: true, plan: validation.plan }
    } catch {
      return { ok: false, code: 'FAILED', message: '本地任务拆解失败，请稍后重试。' }
    }
  }
}
