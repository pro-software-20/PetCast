import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTs } from './load-ts.mjs'

const {
  DEEPSEEK_DIAGNOSTIC_MAX_RESPONSE_BYTES,
  diagnoseDeepSeekUpstream,
} = await loadTs('../server/deepSeekDiagnostics.ts')
const { planTasksWithDeepSeek } = await loadTs('../server/deepSeekTaskPlanner.ts')

const fixed = {
  now: () => new Date('2026-11-02T00:00:00.000Z'),
  monotonicNow: (() => {
    let value = 10
    return () => value += 5
  })(),
}

test('missing DeepSeek key is diagnosed without any network request', async () => {
  let calls = 0
  const result = await diagnoseDeepSeekUpstream({
    ...fixed,
    fetchImpl: async () => {
      calls += 1
      throw new Error('must not run')
    },
  })
  assert.equal(calls, 0)
  assert.deepEqual(result, {
    ready: false,
    code: 'CONFIG_MISSING',
    stage: 'configuration',
    checkedAt: '2026-11-02T00:00:00.000Z',
    durationMs: 5,
    model: 'deepseek-flash',
  })
})

test('DeepSeek model preflight classifies safe HTTP failures', async () => {
  const cases = [
    [400, 'INVALID_REQUEST'],
    [401, 'AUTH_FAILED'],
    [402, 'INSUFFICIENT_BALANCE'],
    [403, 'AUTH_FAILED'],
    [429, 'RATE_LIMITED'],
    [500, 'UPSTREAM_SERVER_ERROR'],
    [503, 'UPSTREAM_SERVER_ERROR'],
    [504, 'UPSTREAM_TIMEOUT'],
  ]
  for (const [status, code] of cases) {
    const result = await diagnoseDeepSeekUpstream({
      apiKey: 'secret-key-that-must-not-leak',
      fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'private upstream body' } }), {
        status,
        headers: status === 429 ? { 'retry-after': '7' } : {},
      }),
    })
    assert.equal(result.code, code)
    assert.equal(result.httpStatus, status)
    if (status === 429) assert.equal(result.retryAfterSeconds, 7)
    const serialized = JSON.stringify(result)
    assert.doesNotMatch(serialized, /secret-key|private upstream body|authorization/i)
  }
})

test('DeepSeek model preflight validates bounded model metadata', async () => {
  const ready = await diagnoseDeepSeekUpstream({
    apiKey: 'test-key',
    model: 'deepseek-flash',
    fetchImpl: async (_url, init) => {
      assert.equal(init.method, 'GET')
      assert.match(init.headers.authorization, /^Bearer /)
      return new Response(JSON.stringify({ data: [
        { id: 'deepseek-flash', object: 'model' },
        { id: 'deepseek-v4-pro', object: 'model' },
      ] }), { status: 200 })
    },
  })
  assert.equal(ready.ready, true)
  assert.equal(ready.code, 'READY')

  const unavailable = await diagnoseDeepSeekUpstream({
    apiKey: 'test-key',
    model: 'missing-model',
    fetchImpl: async () => new Response(JSON.stringify({ data: [{ id: 'deepseek-flash' }] }), { status: 200 }),
  })
  assert.equal(unavailable.code, 'MODEL_UNAVAILABLE')

  const malformed = await diagnoseDeepSeekUpstream({
    apiKey: 'test-key',
    fetchImpl: async () => new Response('{', { status: 200 }),
  })
  assert.equal(malformed.code, 'INVALID_RESPONSE')

  const oversized = await diagnoseDeepSeekUpstream({
    apiKey: 'test-key',
    fetchImpl: async () => new Response('{}', {
      status: 200,
      headers: { 'content-length': String(DEEPSEEK_DIAGNOSTIC_MAX_RESPONSE_BYTES + 1) },
    }),
  })
  assert.equal(oversized.code, 'INVALID_RESPONSE')
})

test('DeepSeek model preflight distinguishes timeout and network failure', async () => {
  const timedOut = await diagnoseDeepSeekUpstream({
    apiKey: 'test-key',
    timeoutMs: 5,
    fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    }),
  })
  assert.equal(timedOut.code, 'UPSTREAM_TIMEOUT')

  const unavailable = await diagnoseDeepSeekUpstream({
    apiKey: 'test-key',
    fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND') },
  })
  assert.equal(unavailable.code, 'NETWORK_UNAVAILABLE')
})

test('planner retains private diagnostics while returning the existing safe protocol', async () => {
  const cases = [
    [400, 'INVALID_REQUEST', 'INVALID_REQUEST'],
    [401, 'AUTH_FAILED', 'UPSTREAM_UNAVAILABLE'],
    [402, 'INSUFFICIENT_BALANCE', 'UPSTREAM_UNAVAILABLE'],
    [429, 'RATE_LIMITED', 'RATE_LIMITED'],
    [503, 'UPSTREAM_SERVER_ERROR', 'UPSTREAM_UNAVAILABLE'],
  ]
  for (const [status, diagnosticCode, publicCode] of cases) {
    const events = []
    const result = await planTasksWithDeepSeek({}, {
      apiKey: 'secret-key',
      fetchImpl: async () => new Response('private upstream body', {
        status,
        headers: status === 429 ? { 'retry-after': '3' } : {},
      }),
      onDiagnostic: event => events.push(event),
    })
    assert.equal(result.ok, false)
    assert.equal(result.code, publicCode)
    assert.equal(events.length, 1)
    assert.equal(events[0].code, diagnosticCode)
    assert.doesNotMatch(JSON.stringify(result), /secret-key|private upstream body|AUTH_FAILED|INSUFFICIENT_BALANCE/)
  }
})
