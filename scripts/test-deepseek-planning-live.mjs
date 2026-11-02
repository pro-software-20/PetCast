import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { planTasksWithDeepSeek } from '../dist-server/server/deepSeekTaskPlanner.js'

const root = fileURLToPath(new URL('..', import.meta.url))
if (process.env.PETCAST_RUN_LIVE_AI_TESTS !== '1') {
  console.log('Skipped live DeepSeek planning: set PETCAST_RUN_LIVE_AI_TESTS=1 to enable it.')
  process.exit(0)
}

const apiKey = process.env.DEEPSEEK_API_KEY?.trim()
if (!apiKey) {
  console.log('Skipped live DeepSeek planning: DEEPSEEK_API_KEY is not configured.')
  process.exit(0)
}

const providers = [
  { id: 'local', displayName: '本地规则', capabilities: ['planning', 'text-generation'], executionModes: ['manual'] },
  { id: 'codex', displayName: 'Codex', capabilities: ['coding', 'file-editing', 'testing'], executionModes: ['manual', 'local-agent'] },
  { id: 'deepseek', displayName: 'DeepSeek', capabilities: ['planning', 'text-generation', 'research', 'coding'], executionModes: ['manual', 'api'] },
  { id: 'doubao', displayName: '豆包', capabilities: ['text-generation', 'research', 'vision'], executionModes: ['manual', 'api'] },
]

const analysis = (taskType, parallel) => ({
  taskType,
  complexity: 'high',
  estimatedInputTokens: { min: 100, max: 500 },
  estimatedOutputTokens: { min: 1200, max: 3500 },
  estimationBasis: 'heuristic-metadata',
  assumptions: ['结果仅基于 Prompt 与附件元信息。'],
  optimizedPrompt: '请保持原任务范围，输出明确交付物与验收方式。',
  promptOptimizationSource: 'local',
  canRunInParallel: parallel,
  parallelPlan: parallel ? ['独立分支并行，最后汇总。'] : ['按依赖顺序执行。'],
  warnings: [],
})

const cases = [
  {
    name: 'mixed-workflow',
    prompt: '分析记账 App 需求，实现核心 React 页面和测试，撰写用户说明，最后汇总并检查一致性。',
    analysis: analysis('mixed', true),
  },
  {
    name: 'parallel-and-join',
    prompt: '1. 独立调研技术方案。2. 独立设计测试策略。3. 基于任务 1 和任务 2 汇总实施计划。',
    analysis: analysis('analysis', true),
  },
]

const report = {
  generatedAt: new Date().toISOString(),
  model: process.env.DEEPSEEK_MODEL?.trim() || 'deepseek-flash',
  calls: [],
}

for (const item of cases) {
  const started = Date.now()
  const result = await planTasksWithDeepSeek({
    prompt: item.prompt,
    analysis: item.analysis,
    files: [],
    providers,
  }, {
    apiKey,
    model: report.model,
    timeoutMs: 30_000,
  })
  const entry = {
    name: item.name,
    durationMs: Date.now() - started,
    ok: result.ok,
  }
  if (result.ok) {
    const roots = result.plan.tasks.filter(task => task.dependsOn.length === 0)
    const dependencies = result.plan.tasks.reduce((total, task) => total + task.dependsOn.length, 0)
    const providerDistribution = Object.fromEntries(providers.map(provider => [
      provider.id,
      result.plan.tasks.filter(task => task.recommendedProviderId === provider.id).length,
    ]).filter(([, count]) => count > 0))
    Object.assign(entry, {
      taskCount: result.plan.tasks.length,
      rootTaskCount: roots.length,
      dependencyCount: dependencies,
      providerDistribution,
      validationPassed: true,
    })
    assert(result.plan.tasks.length >= 1 && result.plan.tasks.length <= 12)
    if (item.name === 'parallel-and-join') {
      assert(roots.length >= 2, 'Parallel scenario should preserve multiple root tasks.')
      assert(dependencies >= 2, 'Join scenario should depend on direct outputs.')
    }
  } else {
    Object.assign(entry, { errorCode: result.code, validationPassed: false })
  }
  report.calls.push(entry)
}

const outputDirectory = path.join(root, 'work')
await mkdir(outputDirectory, { recursive: true })
await writeFile(
  path.join(outputDirectory, 'deepseek-planning-live-report.json'),
  `${JSON.stringify(report, null, 2)}\n`,
  'utf8',
)
assert(report.calls.every(call => call.ok), 'At least one live DeepSeek planning call failed.')
console.log('DeepSeek live planning acceptance completed with two bounded calls.')
