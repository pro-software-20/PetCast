import type { PromptOptimizationSource, TaskAnalysisFile } from '../types/taskAnalysis'

export interface PromptOptimizationContext {
  taskType: string
  files: TaskAnalysisFile[]
}

export interface PromptOptimizationResult {
  optimizedPrompt: string
  source: PromptOptimizationSource
  warning?: string
}

export interface PromptOptimizer {
  optimize(prompt: string, context: PromptOptimizationContext): Promise<PromptOptimizationResult>
}

const normalizePrompt = (prompt: string) => (
  prompt.trim().replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n')
)

const formatFile = (file: TaskAnalysisFile) => {
  const name = file.name.trim() || '未命名文件'
  const type = file.type.trim() || '未知类型'
  return `- ${name}（${type}）`
}

const fileSection = (files: TaskAnalysisFile[]) => files.length === 0 ? [] : [
  '',
  '可参考的文件（当前仅提供文件名和类型，未读取文件内容）：',
  ...files.map(formatFile),
]

const emptyPromptTemplate = (files: TaskAnalysisFile[]) => [
  '请根据现有文件元信息帮助我明确任务。',
  ...fileSection(files),
  '',
  '请先询问或列出仍需补充的任务目标、使用场景、约束条件和期望输出，再给出可执行的下一步建议。',
].join('\n')

const academicWritingRequirements = [
  '请先判断我需要的是选题规划、研究设计、提纲还是正文写作；信息不足时先列出需要确认的问题。',
  '给出清晰的选题或写作步骤、推荐结构、研究方法和文献检索关键词。',
  '不要虚构参考文献、实验数据、临床结论或政策文件；无法确认的信息请明确说明。',
]

const requirementsByType: Record<string, readonly string[]> = {
  writing: [
    '请明确写作目的、目标读者、内容结构、篇幅和语气；缺失的信息请先列出。',
    '先给出写作方案或提纲，再按用户实际要求生成内容，不要擅自扩大任务范围。',
    '涉及事实、数据或引用时不要编造，无法确认的信息请明确说明。',
  ],
  research: [
    '请明确研究问题、范围、时间要求和资料来源标准。',
    '给出检索与筛选步骤，并区分已知事实、合理推断和待验证信息。',
    '最后总结结论、证据不足之处和可复核的方法。',
  ],
  coding: [
    '请先确认技术环境、修改范围、兼容性要求和禁止改动的部分。',
    '给出最小可行的实现步骤，并说明关键修改和潜在风险。',
    '完成后提供可复现的验证方法，不要声称运行了未实际执行的检查。',
  ],
  analysis: [
    '请明确分析对象、判断维度和可使用的依据。',
    '按证据组织分析，区分事实、推断和不确定信息。',
    '最后给出结论、限制和验证方式。',
  ],
  testing: [
    '请明确测试对象、运行环境、预期行为和验收标准。',
    '覆盖正常流程、边界条件和失败场景，并按优先级排列。',
    '输出测试步骤、预期结果和问题复现信息。',
  ],
  general: [
    '请先准确复述目标，并指出完成任务仍缺少的必要信息。',
    '保持原始范围，给出清晰、可执行的步骤。',
    '最后给出结果形式、限制和验证方法。',
  ],
}

const requirementsFor = (taskType: string, prompt: string) => {
  if (taskType === 'writing' && /论文|学术|研究报告|\b(?:paper|thesis|academic)\b/i.test(prompt)) {
    return academicWritingRequirements
  }
  if (taskType === 'mixed') {
    return [
      '请先拆分需求中的不同目标，并说明它们之间是否存在依赖。',
      '在不改变原始范围的前提下，按合理顺序逐项完成。',
      '最后统一检查各部分的一致性，并说明验证方式。',
    ]
  }
  return requirementsByType[taskType] ?? requirementsByType.general
}

export function optimizePrompt(
  prompt: string,
  context: PromptOptimizationContext,
): string {
  const taskType = context.taskType.trim() || 'general'
  const files = Array.isArray(context.files) ? context.files : []
  const normalizedPrompt = normalizePrompt(prompt)

  if (!normalizedPrompt) return emptyPromptTemplate(files)

  const requirements = requirementsFor(taskType, normalizedPrompt)

  return [
    '请根据下面的用户需求完成任务：',
    normalizedPrompt,
    ...fileSection(files),
    '',
    '执行要求：',
    ...requirements.map((requirement) => `- ${requirement}`),
  ].join('\n')
}

export const localPromptOptimizer: PromptOptimizer = {
  async optimize(prompt, context) {
    return {
      optimizedPrompt: optimizePrompt(prompt, context),
      source: 'local',
    }
  },
}
