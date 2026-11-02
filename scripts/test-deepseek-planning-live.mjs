import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { diagnoseDeepSeekUpstream } from '../dist-server/server/deepSeekDiagnostics.js'
import { planTasksWithDeepSeek } from '../dist-server/server/deepSeekTaskPlanner.js'

const root = fileURLToPath(new URL('..', import.meta.url))
if (process.env.PETCAST_RUN_LIVE_AI_TESTS !== '1') {
  console.log('Skipped live DeepSeek planning: set PETCAST_RUN_LIVE_AI_TESTS=1 to enable it.')
  process.exit(0)
}

const apiKey = process.env.DEEPSEEK_API_KEY?.trim()
const model = process.env.DEEPSEEK_MODEL?.trim() || 'deepseek-flash'
const outputDirectory = path.join(root, 'work')
const outputPath = path.join(outputDirectory, 'deepseek-planning-live-report.json')

const providers = [
  { id: 'local', displayName: '本地规则', capabilities: ['planning', 'text-generation'], executionModes: ['manual'] },
  { id: 'codex', displayName: 'Codex', capabilities: ['coding', 'file-editing', 'testing'], executionModes: ['manual', 'local-agent'] },
  { id: 'deepseek', displayName: 'DeepSeek', capabilities: ['planning', 'text-generation', 'research', 'coding'], executionModes: ['manual', 'api'] },
  { id: 'doubao', displayName: '豆包', capabilities: ['text-generation', 'research', 'vision'], executionModes: ['manual', 'api'] },
]

const analysis = {
  taskType: 'mixed',
  complexity: 'high',
  estimatedInputTokens: { min: 100, max: 500 },
  estimatedOutputTokens: { min: 1200, max: 3500 },
  estimationBasis: 'heuristic-metadata',
  assumptions: ['结果仅基于 Prompt 与附件元信息。'],
  optimizedPrompt: '请保持原任务范围，输出明确交付物与验收方式。',
  promptOptimizationSource: 'local',
  canRunInParallel: true,
  parallelPlan: ['独立分支并行，最后汇总。'],
  warnings: [],
}

const report = {
  generatedAt: new Date().toISOString(),
  model,
  diagnostic: await diagnoseDeepSeekUpstream({ apiKey, model, timeoutMs: 15_000 }),
  calls: [],
}

const writeReport = async () => {
  await mkdir(outputDirectory, { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
}

if (!report.diagnostic.ready) {
  await writeReport()
  throw new Error(`DeepSeek preflight failed safely: ${report.diagnostic.code}. No inference request was sent.`)
}

const request = {
  prompt: '分析记账 App 需求，实现核心 React 页面和测试，撰写用户说明，最后汇总并检查一致性。',
  analysis,
  files: [],
  providers,
}
const started = Date.now()
let upstreamDiagnostic
const result = await planTasksWithDeepSeek(request, {
  apiKey,
  model,
  timeoutMs: 30_000,
  onDiagnostic: event => { upstreamDiagnostic = event },
})
const entry = {
  name: 'mixed-workflow',
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
  const qualityPassed = result.plan.tasks.length >= 2
    && result.plan.tasks.length <= 6
    && roots.length >= 1
    && result.plan.tasks.every(task => (
      task.prompt.trim().length > 0
      && task.expectedDeliverables.length > 0
      && task.acceptanceChecks.length > 0
    ))
  Object.assign(entry, {
    taskCount: result.plan.tasks.length,
    rootTaskCount: roots.length,
    dependencyCount: dependencies,
    providerDistribution,
    validationPassed: true,
    qualityPassed,
  })
  assert.equal(qualityPassed, true, 'Live DeepSeek plan failed the bounded quality acceptance.')
} else {
  Object.assign(entry, {
    errorCode: result.code,
    upstreamDiagnostic,
    validationPassed: false,
    qualityPassed: false,
  })
}
report.calls.push(entry)
await writeReport()

assert.equal(report.calls.length, 1, 'Live acceptance must perform at most one inference call.')
assert.equal(result.ok, true, `DeepSeek live planning failed: ${result.code ?? 'unknown'}`)
console.log('DeepSeek live planning acceptance completed with one bounded inference call.')
