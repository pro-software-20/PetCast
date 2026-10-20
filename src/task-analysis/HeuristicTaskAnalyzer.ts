import type {
  TaskAnalysisFile,
  TaskAnalysisInput,
  TaskAnalysisResult,
  TaskComplexity,
  TokenRange,
} from '../types/taskAnalysis'
import type { TaskAnalyzer } from './TaskAnalyzer'

type TaskCategory = 'coding' | 'analysis' | 'writing' | 'research' | 'testing'
type FileKind = 'code' | 'text' | 'pdf' | 'image' | 'binary'

const CODE_EXTENSIONS = new Set([
  'c', 'cc', 'cpp', 'cs', 'css', 'go', 'h', 'hpp', 'html', 'java', 'js', 'jsx',
  'json', 'mjs', 'py', 'rs', 'sql', 'ts', 'tsx', 'vue', 'xml', 'yaml', 'yml',
])

const TEXT_EXTENSIONS = new Set(['csv', 'doc', 'docx', 'md', 'rtf', 'txt'])
const IMAGE_EXTENSIONS = new Set(['gif', 'jpeg', 'jpg', 'png', 'svg', 'webp'])

const CATEGORY_KEYWORDS: Record<TaskCategory, readonly string[]> = {
  coding: [
    'code', 'coding', 'program', 'implement', 'implementation', 'fix', 'modify',
    'edit', 'develop', 'refactor', 'bug', '代码', '编程', '实现', '修复', '修改',
    '开发', '重构', '调试',
  ],
  analysis: [
    'analyze', 'analysis', 'compare', 'comparison', 'explain', 'summarize',
    '分析', '比较', '对比', '解释', '总结',
  ],
  writing: [
    'write', 'writing', 'draft', 'report', 'translate', 'translation', '文案',
    '写作', '撰写', '报告', '翻译',
  ],
  research: [
    'search', 'research', 'look up', 'find', 'latest', 'verify', 'sources',
    '搜索', '调研', '查找', '最新', '资料',
  ],
  testing: [
    'test', 'testing', 'debug', 'validate', 'validation', '测试', '调试', '验证',
  ],
}

const CATEGORY_ORDER: readonly TaskCategory[] = [
  'coding', 'analysis', 'writing', 'research', 'testing',
]

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const containsKeyword = (text: string, keyword: string) => {
  const normalizedKeyword = keyword.toLowerCase()
  if (/^[a-z0-9 ]+$/.test(normalizedKeyword)) {
    return new RegExp(`\\b${escapeRegExp(normalizedKeyword)}\\b`, 'i').test(text)
  }
  return text.includes(normalizedKeyword)
}

const matchedCategories = (text: string): Set<TaskCategory> => {
  const normalizedText = text.toLowerCase()
  const matches = new Set<TaskCategory>()
  for (const category of CATEGORY_ORDER) {
    if (CATEGORY_KEYWORDS[category].some((keyword) => containsKeyword(normalizedText, keyword))) {
      matches.add(category)
    }
  }
  return matches
}

const getExtension = (name: string) => {
  const lastDot = name.toLowerCase().lastIndexOf('.')
  return lastDot >= 0 ? name.slice(lastDot + 1) : ''
}

const getFileKind = (file: TaskAnalysisFile): FileKind => {
  const type = file.type.toLowerCase().trim()
  const extension = getExtension(file.name)

  if (type === 'application/pdf' || extension === 'pdf') return 'pdf'
  if (type.startsWith('image/') || IMAGE_EXTENSIONS.has(extension)) return 'image'
  if (type.startsWith('text/') || TEXT_EXTENSIONS.has(extension)) return 'text'
  if (type.includes('javascript') || type.includes('typescript') || type.includes('json')) return 'code'
  if (CODE_EXTENSIONS.has(extension)) return 'code'
  return 'binary'
}

const addFileCategoryHints = (categories: Set<TaskCategory>, kind: FileKind) => {
  if (kind === 'code') categories.add('coding')
  if (kind === 'text' || kind === 'pdf' || kind === 'image') categories.add('analysis')
}

const getSafeFileSize = (file: TaskAnalysisFile, warnings: Set<string>) => {
  if (!Number.isFinite(file.size) || file.size < 0) {
    warnings.add('存在文件大小无效，已按 0 字节处理。')
    return 0
  }
  return file.size
}

const addRange = (left: TokenRange, right: TokenRange): TokenRange => ({
  min: left.min + right.min,
  max: left.max + right.max,
})

const estimateFileTokens = (size: number, kind: FileKind): TokenRange => {
  const metadata: TokenRange = { min: 32, max: 64 }

  if (kind === 'code' || kind === 'text') {
    return addRange(metadata, {
      min: Math.ceil(size / 4),
      max: Math.ceil(size / 2),
    })
  }

  if (kind === 'pdf') {
    return addRange(metadata, {
      min: Math.ceil(size / 8),
      max: Math.ceil(size / 3),
    })
  }

  // Image and other binary files need a rough multimodal/metadata estimate.
  // File size still affects the range, but it is not treated as text content.
  return addRange(metadata, {
    min: 100 + Math.ceil(size / 100_000),
    max: 800 + Math.ceil(size / 50_000),
  })
}

const detectIndependentTasks = (prompt: string, categoryCount: number) => {
  const numberedItems = prompt.match(/(?:^|\n)\s*(?:\d+[.)]|[一二三四五六七八九十]+[、.)])/g)?.length ?? 0
  const independentMarker = /并行|分别|各自|互不依赖|独立任务|parallel|independent|separately/i.test(prompt)
  return numberedItems >= 2 || (independentMarker && categoryCount >= 2)
}

const createParallelPlan = (canRunInParallel: boolean): string[] => (
  canRunInParallel
    ? ['将识别到的独立子任务分别处理。', '最后汇总结果并统一校验。']
    : []
)

const complexityFromScore = (score: number): TaskComplexity => {
  if (score >= 6) return 'high'
  if (score >= 3) return 'medium'
  return 'low'
}

const outputTokensByComplexity: Record<TaskComplexity, TokenRange> = {
  low: { min: 150, max: 500 },
  medium: { min: 500, max: 1_500 },
  high: { min: 1_200, max: 3_500 },
}

const normalizePrompt = (prompt: string) => prompt.trim().replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n')

export class HeuristicTaskAnalyzer implements TaskAnalyzer {
  async analyze(input: TaskAnalysisInput): Promise<TaskAnalysisResult> {
    const prompt = typeof input.prompt === 'string' ? input.prompt : ''
    const normalizedPrompt = normalizePrompt(prompt)
    const files = Array.isArray(input.files) ? input.files : []
    const warnings = new Set<string>(['Token 结果为估算值，不是精确账单。'])
    const categories = matchedCategories(normalizedPrompt)
    const complexitySignals = new Set<string>()

    if (normalizedPrompt.length === 0) {
      warnings.add('Prompt 为空，当前分析仅使用默认结果。')
    }
    if (normalizedPrompt.length > 8_000) {
      warnings.add('Prompt 较长，Token 估算不确定性较高。')
    }
    if (files.length === 0) {
      warnings.add('未提供文件，本次估算仅基于 Prompt。')
    }

    for (const category of categories) complexitySignals.add(category)

    const fileEstimates: TokenRange[] = []
    let hasUncertainFile = false
    let hasLargeFile = false

    for (const file of files) {
      const kind = getFileKind(file)
      const size = getSafeFileSize(file, warnings)
      addFileCategoryHints(categories, kind)
      fileEstimates.push(estimateFileTokens(size, kind))

      if (kind === 'code') complexitySignals.add('code')
      if (kind === 'pdf') {
        complexitySignals.add('pdf')
        hasUncertainFile = true
      }
      if (kind === 'image') {
        complexitySignals.add('image')
        hasUncertainFile = true
      }
      if (kind === 'binary') hasUncertainFile = true
      if (size > 1_000_000) hasLargeFile = true
    }

    if (hasUncertainFile) {
      warnings.add('包含图片、PDF 或其他二进制文件，Token 结果为粗略估算。')
    }

    const canRunInParallel = detectIndependentTasks(normalizedPrompt, categories.size)
    const complexityScore = (normalizedPrompt.length > 400 ? 1 : 0)
      + (normalizedPrompt.length > 1_200 ? 1 : 0)
      + (files.length > 0 && files.length <= 2 ? 1 : 0)
      + (files.length >= 3 ? 2 : 0)
      + (hasLargeFile ? 1 : 0)
      + complexitySignals.size
      + (canRunInParallel ? 2 : 0)
    const complexity = complexityFromScore(complexityScore)

    let inputTokens: TokenRange = {
      min: Math.ceil(normalizedPrompt.length / 4),
      max: Math.ceil(normalizedPrompt.length / 2),
    }
    for (const estimate of fileEstimates) inputTokens = addRange(inputTokens, estimate)

    let taskType = 'general'
    if (categories.size === 1) taskType = [...categories][0]
    else if (categories.size > 1) taskType = 'mixed'

    return {
      taskType,
      complexity,
      estimatedInputTokens: inputTokens,
      estimatedOutputTokens: outputTokensByComplexity[complexity],
      optimizedPrompt: normalizedPrompt,
      canRunInParallel,
      parallelPlan: createParallelPlan(canRunInParallel),
      warnings: [...warnings],
    }
  }
}
