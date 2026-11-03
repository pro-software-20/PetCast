import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { runPublicAiAcceptance } from '../scripts/test-public-ai-deployment.mjs'

const validPlan = {
  schemaVersion: 1,
  id: 'public-test-plan',
  title: '公网规划验收',
  goal: '验证公网任务规划服务',
  assumptions: ['仅使用测试元信息。'],
  tasks: [
    {
      id: 'analyze', title: '分析需求', description: '分析目标和边界。', dependsOn: [],
      recommendedProviderId: 'deepseek', executionMode: 'manual',
      prompt: '分析目标，输出范围、交付物和验收方式。',
      files: { inputs: [], readPaths: [], allowedWritePaths: [], forbiddenPaths: [], outputPaths: [] },
      expectedDeliverables: ['需求分析'], acceptanceChecks: ['范围明确'],
    },
    {
      id: 'implement', title: '实现功能', description: '根据分析实现代码。', dependsOn: ['analyze'],
      recommendedProviderId: 'codex', executionMode: 'manual',
      prompt: '根据前置分析实现代码，给出交付物和验证方式。',
      files: { inputs: [], readPaths: [], allowedWritePaths: [], forbiddenPaths: [], outputPaths: [] },
      expectedDeliverables: ['实现结果'], acceptanceChecks: ['实现可验证'],
    },
  ],
  finalAcceptanceChecks: ['所有任务均已验收'],
}

const withServer = async handler => {
  const server = createServer(handler)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  try {
    return await runPublicAiAcceptance({
      serviceUrl: `http://127.0.0.1:${address.port}`,
      live: true,
      allowLoopbackHttp: true,
      writeReport: false,
    })
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

test('public deployment acceptance checks health, safe rejection, and one live plan', async () => {
  let planningCalls = 0
  const report = await withServer((request, response) => {
    response.setHeader('content-type', 'application/json')
    if (request.method === 'GET' && request.url === '/health') {
      response.end(JSON.stringify({ ok: true, service: 'petcast-ai', version: 1 }))
      return
    }
    if (request.method === 'POST' && request.url === '/v1/task/plan') {
      const chunks = []
      request.on('data', chunk => chunks.push(chunk))
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (Object.keys(body).length === 0) {
          response.statusCode = 400
          response.end(JSON.stringify({ ok: false, code: 'INVALID_REQUEST' }))
          return
        }
        planningCalls += 1
        response.end(JSON.stringify({ ok: true, provider: 'deepseek', plan: validPlan }))
      })
      return
    }
    response.statusCode = 404
    response.end('{}')
  })
  assert.equal(report.ok, true)
  assert.equal(report.livePlanning.validationPassed, true)
  assert.equal(planningCalls, 1)
})

test('public deployment acceptance rejects non-HTTPS public origins', async () => {
  await assert.rejects(
    runPublicAiAcceptance({ serviceUrl: 'http://example.com', writeReport: false }),
    /valid HTTPS origin/,
  )
})
