import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { normalizePublicAiServiceUrl } from './public-ai-config.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const reportPath = path.join(root, 'work', 'public-ai-acceptance.json')

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

const liveRequest = {
  prompt: '分析记账 App 需求，实现核心 React 页面和测试，撰写用户说明，最后汇总并检查一致性。',
  analysis,
  files: [],
  providers,
}

const fetchWithTimeout = async (fetchImpl, url, init = {}, timeoutMs = 20_000) => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

const safeJson = async response => {
  const text = await response.text()
  assert(Buffer.byteLength(text) <= 512 * 1024, 'Public AI response exceeded the safe acceptance limit.')
  return JSON.parse(text)
}

const qualitySummary = plan => {
  const roots = plan.tasks.filter(task => task.dependsOn.length === 0)
  const dependencyCount = plan.tasks.reduce((total, task) => total + task.dependsOn.length, 0)
  const providerDistribution = Object.fromEntries(providers.map(provider => [
    provider.id,
    plan.tasks.filter(task => task.recommendedProviderId === provider.id).length,
  ]).filter(([, count]) => count > 0))
  const qualityPassed = plan.tasks.length >= 2
    && plan.tasks.length <= 6
    && roots.length >= 1
    && plan.tasks.every(task => (
      task.prompt.trim().length > 0
      && task.expectedDeliverables.length > 0
      && task.acceptanceChecks.length > 0
    ))
  return {
    taskCount: plan.tasks.length,
    rootTaskCount: roots.length,
    dependencyCount,
    providerDistribution,
    qualityPassed,
  }
}

export async function runPublicAiAcceptance({
  serviceUrl,
  live = false,
  fetchImpl = fetch,
  allowLoopbackHttp = false,
  writeReport = true,
} = {}) {
  const normalized = normalizePublicAiServiceUrl(serviceUrl)
  let serviceOrigin = normalized
  if (!serviceOrigin && allowLoopbackHttp) {
    const candidate = new URL(serviceUrl)
    if (candidate.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(candidate.hostname)
      && !candidate.username && !candidate.password && !candidate.search && !candidate.hash) {
      serviceOrigin = candidate.origin
    }
  }
  assert(serviceOrigin, 'PETCAST_PUBLIC_AI_API_URL must be a valid HTTPS origin.')

  const report = {
    generatedAt: new Date().toISOString(),
    serviceOrigin,
    livePlanningEnabled: live,
    health: null,
    invalidRequest: null,
    livePlanning: live ? { attempted: false } : { attempted: false, skipped: true },
    ok: false,
  }
  const persist = async () => {
    if (!writeReport) return
    await mkdir(path.dirname(reportPath), { recursive: true })
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  }

  try {
    const healthStarted = Date.now()
    const healthResponse = await fetchWithTimeout(fetchImpl, `${serviceOrigin}/health`)
    const health = await safeJson(healthResponse)
    assert.equal(healthResponse.status, 200)
    assert.deepEqual(health, { ok: true, service: 'petcast-ai', version: 1 })
    report.health = { status: healthResponse.status, durationMs: Date.now() - healthStarted, valid: true }

    const invalidResponse = await fetchWithTimeout(fetchImpl, `${serviceOrigin}/v1/task/plan`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-petcast-install-id': randomUUID(),
      },
      body: '{}',
    })
    const invalid = await safeJson(invalidResponse)
    assert.equal(invalidResponse.status, 400)
    assert.deepEqual(invalid, { ok: false, code: 'INVALID_REQUEST' })
    report.invalidRequest = { status: invalidResponse.status, safelyRejected: true }

    if (live) {
      report.livePlanning = { attempted: true }
      const liveStarted = Date.now()
      const planningResponse = await fetchWithTimeout(fetchImpl, `${serviceOrigin}/v1/task/plan`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-petcast-install-id': randomUUID(),
        },
        body: JSON.stringify(liveRequest),
      }, 45_000)
      const result = await safeJson(planningResponse)
      assert.equal(planningResponse.status, 200)
      assert.equal(result.ok, true)
      assert.equal(result.provider, 'deepseek')

      const { sanitizeRemoteTaskPlan } = await import('../dist-server/electron/taskPlanningProtocol.js')
      const validatedPlan = sanitizeRemoteTaskPlan(result.plan, liveRequest)
      assert(validatedPlan, 'Public AI service returned an invalid task graph.')
      const summary = qualitySummary(validatedPlan)
      assert.equal(summary.qualityPassed, true, 'Public AI service failed bounded planning quality checks.')
      report.livePlanning = {
        attempted: true,
        durationMs: Date.now() - liveStarted,
        validationPassed: true,
        ...summary,
      }
    }

    report.ok = true
    await persist()
    return report
  } catch (error) {
    report.failureStage = report.health === null
      ? 'health'
      : report.invalidRequest === null ? 'invalid-request' : 'live-planning'
    await persist()
    throw error
  }
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : ''
if (entry === import.meta.url) {
  const serviceUrl = process.env.PETCAST_PUBLIC_AI_API_URL?.trim()
  const live = process.env.PETCAST_RUN_PUBLIC_AI_TESTS === '1'
  const report = await runPublicAiAcceptance({ serviceUrl, live })
  console.log(`Public AI acceptance passed for ${report.serviceOrigin}.`)
  console.log(live
    ? 'One bounded DeepSeek planning request was validated.'
    : 'No inference request was sent. Set PETCAST_RUN_PUBLIC_AI_TESTS=1 for one bounded live check.')
  console.log('Detailed safe output is in work/public-ai-acceptance.json.')
}
