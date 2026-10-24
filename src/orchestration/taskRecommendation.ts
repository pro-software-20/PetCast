import type {
  ProviderCapability,
  ProviderId,
  ProviderProfile,
  TaskInputFileReference,
  TaskProviderRecommendation,
  TaskWorkCategory,
} from '../types/taskOrchestration'

export interface TaskRecommendationInput {
  title: string
  description: string
  prompt: string
  globalTaskType: string
  files: TaskInputFileReference[]
  availableProviders: ProviderProfile[]
  categoryHint?: TaskWorkCategory
}

export interface TaskRecommendationResult {
  recommendedProviderId: ProviderId
  recommendation: TaskProviderRecommendation
}

type ScoreMap = Record<TaskWorkCategory, number>

const categories: TaskWorkCategory[] = [
  'planning',
  'coding',
  'testing',
  'research',
  'analysis',
  'writing',
  'review',
  'vision',
  'general',
]

const categoryPriority: TaskWorkCategory[] = [
  'coding',
  'testing',
  'research',
  'vision',
  'writing',
  'review',
  'planning',
  'analysis',
  'general',
]

const codeFilePattern = /\.(?:[cm]?[jt]sx?|py|java|kt|kts|go|rs|rb|php|cs|cpp|c|h|hpp|css|scss|less|html|vue|svelte|sql|sh|ps1|json|ya?ml|toml)$/i
const documentFilePattern = /\.(?:pdf|docx?|md|txt|rtf|odt)$/i
const imageFilePattern = /\.(?:png|jpe?g|webp|gif|bmp|svg|tiff?)$/i

const makeScores = (): ScoreMap => Object.fromEntries(categories.map(category => [category, 0])) as ScoreMap

const add = (scores: ScoreMap, category: TaskWorkCategory, points: number, matched: string[]) => {
  scores[category] += points
  matched.push(category)
}

const matches = (text: string, pattern: RegExp) => pattern.test(text)

const globalFallbackCategory = (taskType: string): TaskWorkCategory => {
  if (categories.includes(taskType as TaskWorkCategory)) return taskType as TaskWorkCategory
  if (taskType === 'mixed') return 'planning'
  return 'general'
}

const providerForCategory = (
  category: TaskWorkCategory,
  text: string,
): { preferredId: ProviderId; requiredCapabilities: ProviderCapability[]; reason: string } => {
  if (category === 'coding') return {
    preferredId: 'codex',
    requiredCapabilities: matches(text, /修改|更新|编辑|重构|修复|创建|新增|写入|文件|组件|接口|代码|\b(?:edit|modify|refactor|fix|file|code)\b/i)
      ? ['coding', 'file-editing']
      : ['coding'],
    reason: '检测到代码实现或项目文件修改需求，Codex 更适合完成代码变更并给出验证记录。',
  }
  if (category === 'testing') {
    const needsExecution = matches(text, /运行|执行|自动化|编写测试|修复测试|测试代码|单元测试|集成测试|端到端|构建|typecheck|\b(?:run|execute|automation|unit test|integration test|e2e|build)\b/i)
    return needsExecution
      ? {
          preferredId: 'codex',
          requiredCapabilities: ['testing'],
          reason: '任务需要执行或编写测试并记录实际结果，Codex 更适合代码环境中的验证工作。',
        }
      : {
          preferredId: 'deepseek',
          requiredCapabilities: ['planning'],
          reason: '任务重点是设计测试方案和覆盖范围，DeepSeek 更适合先完成结构化测试规划。',
        }
  }
  if (category === 'research') return {
    preferredId: 'deepseek',
    requiredCapabilities: ['research'],
    reason: '任务需要检索、比较或核验资料，DeepSeek 更适合结构化研究并标注不确定信息。',
  }
  if (category === 'writing') return {
    preferredId: 'doubao',
    requiredCapabilities: ['text-generation'],
    reason: '任务以中文写作、翻译或表达优化为主，豆包更适合组织自然、连贯的文本。',
  }
  if (category === 'review') {
    const languageReview = matches(text, /润色|校对|语病|措辞|语言|表达|\b(?:proofread|polish|wording)\b/i)
    return languageReview
      ? {
          preferredId: 'doubao',
          requiredCapabilities: ['text-generation'],
          reason: '任务重点是语言核查和润色，豆包更适合改善中文结构与表达。',
        }
      : {
          preferredId: 'deepseek',
          requiredCapabilities: ['planning'],
          reason: '任务需要复核逻辑、事实或交付完整性，DeepSeek 更适合结构化审查。',
        }
  }
  if (category === 'vision') return {
    preferredId: 'doubao',
    requiredCapabilities: ['vision'],
    reason: '任务涉及图片或视觉内容理解，优先推荐具备视觉能力的豆包。',
  }
  if (category === 'planning') return {
    preferredId: 'deepseek',
    requiredCapabilities: ['planning'],
    reason: '任务以需求梳理、方案设计或依赖规划为主，DeepSeek 更适合结构化推演。',
  }
  if (category === 'analysis') return {
    preferredId: 'deepseek',
    requiredCapabilities: ['planning'],
    reason: '任务以分析、比较或解释为主，DeepSeek 更适合整理依据、结论和不确定性。',
  }
  return {
    preferredId: 'deepseek',
    requiredCapabilities: ['planning'],
    reason: '当前子任务缺少明确的专业信号，暂按通用分析任务推荐 DeepSeek。',
  }
}

const supportsAll = (provider: ProviderProfile, capabilities: ProviderCapability[]) => (
  provider.executionModes.includes('manual')
  && capabilities.every(capability => provider.capabilities.includes(capability))
)

const selectProvider = (
  preferredId: ProviderId,
  requiredCapabilities: ProviderCapability[],
  providers: ProviderProfile[],
) => {
  const manualProviders = providers.filter(provider => provider.executionModes.includes('manual'))
  const preferred = manualProviders.find(provider => provider.id === preferredId)
  if (preferred && supportsAll(preferred, requiredCapabilities)) {
    return { providerId: preferred.id, usedFallback: false, displayName: preferred.displayName }
  }
  const capabilityMatch = manualProviders.find(provider => supportsAll(provider, requiredCapabilities))
  if (capabilityMatch) {
    return { providerId: capabilityMatch.id, usedFallback: true, displayName: capabilityMatch.displayName }
  }
  const local = manualProviders.find(provider => provider.id === 'local')
  return {
    providerId: local?.id ?? 'local',
    usedFallback: true,
    displayName: local?.displayName ?? '本地规则',
  }
}

export function recommendTaskProvider(input: TaskRecommendationInput): TaskRecommendationResult {
  const text = `${input.title}\n${input.description}\n${input.prompt}`.trim()
  const scores = makeScores()
  const matched: string[] = []

  if (input.categoryHint) add(scores, input.categoryHint, 12, matched)

  if (matches(text, /(?:修改|更新|编辑|维护|写入|新增|创建).{0,24}(?:README|文档文件|代码|组件|接口|配置|脚本|\.md\b)|(?:README|\.md\b).{0,16}(?:修改|更新|编辑)/i)) {
    add(scores, 'coding', 10, matched)
  }
  if (matches(text, /代码|编程|实现|修复|开发|重构|组件|接口|函数|数据库|脚本|补丁|diff|\b(?:code|implement|fix|develop|refactor|component|function|database|script|patch)\b/i)) {
    add(scores, 'coding', 6, matched)
  }
  if (matches(text, /测试方案|测试计划|测试用例|设计.{0,8}测试|覆盖范围|\b(?:test plan|test case|test design|coverage plan)\b/i)) {
    add(scores, 'testing', 7, matched)
  } else if (matches(text, /测试|调试|验证|构建|typecheck|\b(?:test|debug|validate|verify|build)\b/i)) {
    add(scores, 'testing', 6, matched)
  }
  if (matches(text, /(?:运行|执行|自动化|编写|修复).{0,10}(?:测试|用例)|(?:测试|用例).{0,10}(?:运行|执行|失败|修复)|\b(?:run|execute|fix).{0,12}(?:test|spec)\b/i)) {
    add(scores, 'testing', 4, matched)
  }
  if (matches(text, /调研|检索|搜索|资料|文献|来源|最新|事实核验|查证|\b(?:research|search|source|literature|fact-check)\b/i)) {
    add(scores, 'research', 6, matched)
  }
  if (matches(text, /写一篇|撰写|写作|文章|论文|文案|翻译|改写|摘要|说明书|使用说明|\b(?:write|draft|article|paper|copywriting|translate|rewrite)\b/i)) {
    add(scores, 'writing', 6, matched)
  }
  if (matches(text, /润色|校对|复核|审查|评审|核查|检查逻辑|\b(?:polish|proofread|review|audit)\b/i)) {
    add(scores, 'review', 7, matched)
  }
  if (matches(text, /图片|图像|截图|视觉|识图|看图|\b(?:image|screenshot|visual|vision)\b/i)) {
    add(scores, 'vision', 7, matched)
  }
  if (matches(text, /需求|方案|架构|规划|计划|拆分|依赖|范围|提纲|\b(?:requirements?|design|architecture|plan|scope|outline)\b/i)) {
    add(scores, 'planning', 6, matched)
  }
  if (matches(text, /分析|比较|解释|总结|归纳|评估|\b(?:analy[sz]e|compare|explain|summari[sz]e|evaluate)\b/i)) {
    add(scores, 'analysis', 5, matched)
  }

  let fileSignal = false
  for (const file of input.files) {
    const name = file.kind === 'workspace' ? file.path : file.name
    const type = file.kind === 'attachment' ? file.type : ''
    if (imageFilePattern.test(name) || type.startsWith('image/')) {
      scores.vision += 2
      fileSignal = true
    } else if (codeFilePattern.test(name) || /(?:javascript|typescript|json|xml|css|html|python|java)/i.test(type)) {
      scores.coding += 2
      fileSignal = true
    } else if (documentFilePattern.test(name) || /(?:pdf|text|document|word)/i.test(type)) {
      scores.research += 1
      fileSignal = true
    }
  }

  const maxScore = Math.max(...categories.map(category => scores[category]))
  const usedGlobalFallback = maxScore === 0
  const category = usedGlobalFallback
    ? globalFallbackCategory(input.globalTaskType)
    : categoryPriority.find(candidate => scores[candidate] === maxScore) ?? 'general'
  const base = providerForCategory(category, text)
  const selection = selectProvider(base.preferredId, base.requiredCapabilities, input.availableProviders)
  const confidence = selection.usedFallback || usedGlobalFallback
    ? 'low'
    : input.categoryHint || maxScore >= 6
      ? 'high'
      : fileSignal || matched.length > 0
        ? 'medium'
        : 'low'
  const reason = selection.usedFallback
    ? `${base.reason} 首选 AI 当前不可用或能力不匹配，已回退到${selection.displayName}。`
    : base.reason

  return {
    recommendedProviderId: selection.providerId,
    recommendation: {
      category,
      requiredCapabilities: [...base.requiredCapabilities],
      confidence,
      reason,
    },
  }
}
