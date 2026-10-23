import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadTs } from './load-ts.mjs'

const protocol = await loadTs('../electron/promptOptimizationProtocol.ts')
const { requestPromptOptimization } = await loadTs('../electron/promptOptimizationClient.ts')
const { optimizePromptWithDeepSeek } = await loadTs('../server/deepSeekPromptOptimizer.ts')
const { AnonymousRateLimiter } = await loadTs('../server/anonymousRateLimiter.ts')
const { createPromptOptimizationServer } = await loadTs('../server/main.ts')

const installId = '123e4567-e89b-42d3-a456-426614174000'
const request = {
  prompt: '我想写一篇与中医药相关的论文建议怎么做',
  taskType: 'writing',
  files: [{ name: 'outline.md', type: 'text/markdown', size: 12 }],
}

test('prompt request validation sanitizes unknown fields and file content', () => {
  const sanitized = protocol.sanitizePromptOptimizationRequest({
    ...request,
    secret: 'must-not-cross-ipc',
    files: [{ ...request.files[0], content: 'private file contents' }],
  })
  assert.deepEqual(sanitized, request)
  assert.doesNotMatch(JSON.stringify(sanitized), /secret|private file contents/)
})

test('prompt request validation enforces prompt and file limits', () => {
  assert.equal(protocol.isPromptOptimizationRequest({ ...request, prompt: '' }), false)
  assert.equal(protocol.isPromptOptimizationRequest({ ...request, prompt: 'a'.repeat(8001) }), false)
  assert.equal(protocol.isPromptOptimizationRequest({
    ...request,
    files: [{ ...request.files[0], size: 100 * 1024 * 1024 + 1 }],
  }), false)
})

test('prompt service result validation rejects unexpected response fields', () => {
  assert.equal(protocol.isPromptOptimizationResult({
    ok: true,
    optimizedPrompt: 'safe result',
    provider: 'deepseek',
    debug: 'must not reach renderer',
  }), false)
  assert.equal(protocol.isPromptOptimizationResult({
    ok: false,
    code: 'UPSTREAM_UNAVAILABLE',
    detail: 'private upstream error',
  }), false)
})

test('DeepSeek optimizer sends metadata-only JSON and accepts a valid optimized prompt', async () => {
  let upstreamBody
  const result = await optimizePromptWithDeepSeek(request, {
    apiKey: 'test-key',
    fetchImpl: async (_url, init) => {
      upstreamBody = JSON.parse(init.body)
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ optimizedPrompt: '自然的优化结果' }) } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })

  assert.deepEqual(result, { ok: true, optimizedPrompt: '自然的优化结果', provider: 'deepseek' })
  assert.equal(upstreamBody.model, 'deepseek-flash')
  assert.deepEqual(upstreamBody.thinking, { type: 'disabled' })
  assert.deepEqual(upstreamBody.response_format, { type: 'json_object' })
  const userPayload = JSON.parse(upstreamBody.messages[1].content)
  assert.deepEqual(userPayload.fileMetadata, request.files)
  assert.equal(userPayload.fileMetadata[0].content, undefined)
})

test('DeepSeek optimizer rejects malformed JSON and maps upstream timeout', async () => {
  const malformed = await optimizePromptWithDeepSeek(request, {
    apiKey: 'test-key',
    fetchImpl: async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'not-json' } }],
    }), { status: 200 }),
  })
  assert.deepEqual(malformed, { ok: false, code: 'INVALID_RESPONSE' })

  const unexpectedField = await optimizePromptWithDeepSeek(request, {
    apiKey: 'test-key',
    fetchImpl: async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        optimizedPrompt: 'valid text',
        answer: 'must not be accepted',
      }) } }],
    }), { status: 200 }),
  })
  assert.deepEqual(unexpectedField, { ok: false, code: 'INVALID_RESPONSE' })

  const timedOut = await optimizePromptWithDeepSeek(request, {
    apiKey: 'test-key',
    timeoutMs: 5,
    fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    }),
  })
  assert.deepEqual(timedOut, { ok: false, code: 'UPSTREAM_TIMEOUT' })
})

test('Electron prompt client accepts HTTPS and loopback HTTP but rejects public plaintext HTTP', async () => {
  const success = { ok: true, optimizedPrompt: 'optimized', provider: 'deepseek' }
  let called = 0
  const fetchImpl = async () => {
    called += 1
    return new Response(JSON.stringify(success), { status: 200 })
  }
  assert.deepEqual(await requestPromptOptimization(request, {
    endpoint: 'http://127.0.0.1:8787', installId, fetchImpl,
  }), success)
  assert.deepEqual(await requestPromptOptimization(request, {
    endpoint: 'http://example.com', installId, fetchImpl,
  }), { ok: false, code: 'UPSTREAM_UNAVAILABLE' })
  assert.equal(called, 1)
})

test('daily limiter persists counters and stores only HMAC identifiers', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'petcast-rate-limit-'))
  const statePath = path.join(directory, 'state.json')
  const limits = {
    installPerMinute: 5,
    installPerDay: 1,
    ipPerMinute: 5,
    ipPerDay: 5,
    globalPerDay: 5,
  }
  const now = new Date('2026-10-22T12:00:00.000Z')
  const first = new AnonymousRateLimiter('a'.repeat(32), statePath, limits)
  assert.deepEqual(await first.consume(installId, '203.0.113.9', now), { allowed: true })
  assert.equal((await first.consume(installId, '203.0.113.9', now)).allowed, false)

  const persisted = await readFile(statePath, 'utf8')
  assert.doesNotMatch(persisted, new RegExp(installId))
  assert.doesNotMatch(persisted, /203\.0\.113\.9/)
  const restored = new AnonymousRateLimiter('a'.repeat(32), statePath, limits)
  assert.equal((await restored.consume(installId, '203.0.113.9', now)).allowed, false)
})

const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => resolve(server.address().port))
})
const close = server => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))

test('HTTP service strips unknown fields before optimizer invocation', async () => {
  let received
  const server = createPromptOptimizationServer({
    limiter: { consume: async () => ({ allowed: true }) },
    optimize: async input => {
      received = input
      return { ok: true, optimizedPrompt: 'server result', provider: 'deepseek' }
    },
  })
  const port = await listen(server)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/prompt/optimize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-petcast-install-id': installId },
      body: JSON.stringify({
        ...request,
        secret: 'drop-me',
        files: [{ ...request.files[0], content: 'drop-file-content' }],
      }),
    })
    assert.equal(response.status, 200)
    assert.deepEqual(received, request)
  } finally {
    await close(server)
  }
})

test('HTTP service returns structured rate-limit responses', async () => {
  const server = createPromptOptimizationServer({
    limiter: { consume: async () => ({ allowed: false, retryAfterSeconds: 45 }) },
    optimize: async () => { throw new Error('must not run') },
  })
  const port = await listen(server)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/prompt/optimize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-petcast-install-id': installId },
      body: JSON.stringify(request),
    })
    assert.equal(response.status, 429)
    assert.deepEqual(await response.json(), {
      ok: false,
      code: 'RATE_LIMITED',
      retryAfterSeconds: 45,
    })
  } finally {
    await close(server)
  }
})
