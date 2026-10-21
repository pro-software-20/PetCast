import type { TaskAnalysisFile } from '../types/taskAnalysis'

export interface PromptOptimizationContext {
  taskType: string
  files: TaskAnalysisFile[]
}

const normalizePrompt = (prompt: string) => (
  prompt.trim().replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n')
)

const formatFile = (file: TaskAnalysisFile) => {
  const name = file.name.trim() || '未命名文件'
  const type = file.type.trim() || '未知类型'
  return `- ${name}（${type}）`
}

const emptyPromptTemplate = (taskType: string, files: TaskAnalysisFile[]) => [
  `任务类型：${taskType}`,
  '',
  '任务目标：',
  '请补充需要完成的具体任务。',
  '',
  '相关文件：',
  ...(files.length > 0 ? files.map(formatFile) : ['- 未提供文件']),
  '',
  '执行要求：',
  '- 请明确任务范围、约束条件和期望结果。',
  '- 信息不足时先指出缺失信息。',
  '- 最后给出结论和验证方式。',
].join('\n')

export function optimizePrompt(
  prompt: string,
  context: PromptOptimizationContext,
): string {
  const taskType = context.taskType.trim() || 'general'
  const files = Array.isArray(context.files) ? context.files : []
  const normalizedPrompt = normalizePrompt(prompt)

  if (!normalizedPrompt) return emptyPromptTemplate(taskType, files)

  return [
    `任务类型：${taskType}`,
    '',
    '任务目标：',
    normalizedPrompt,
    '',
    '相关文件：',
    ...(files.length > 0 ? files.map(formatFile) : ['- 未提供文件']),
    '',
    '执行要求：',
    '- 保持原任务范围，不擅自扩展。',
    '- 信息不足时明确指出缺失信息。',
    '- 最后给出结论和验证方式。',
    '',
    '说明：以上内容是对原 Prompt 的保守结构化整理，实际执行前请以用户原始意图为准。',
  ].join('\n')
}
