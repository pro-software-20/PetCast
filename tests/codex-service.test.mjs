import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { loadTs } from './load-ts.mjs'
const { normalizeCodexLimits, readCodexQuota, findCodexExecutable } = await loadTs('../electron/codexUsage.ts')
const short = { usedPercent: 25, windowDurationMins: 300, resetsAt: 1792495260 }
const weekly = { usedPercent: 80, windowDurationMins: 10080, resetsAt: 1792894548 }
const limits = (bucket = {}) => ({ rateLimitsByLimitId: { codex: { limitId: 'codex', primary: short, secondary: weekly, ...bucket } } })
const account = email => ({ account: { type: 'chatgpt', email: email ?? 'fixture@example.invalid', planType: 'plus' } })

test('normalization prefers Codex bucket and matches swapped windows by duration', () => {
  const result = normalizeCodexLimits({ ...limits({ primary: weekly, secondary: short }), rateLimits: {} }, 'scope')
  assert.equal(result.shortWindowRemaining, 75)
  assert.equal(result.weeklyRemaining, 20)
  assert.equal(result.shortWindowResetAt, new Date(short.resetsAt * 1000).toISOString())
})
test('legacy single bucket works only when keyed response absent', () => {
  assert.equal(normalizeCodexLimits({ rateLimits: limits().rateLimitsByLimitId.codex }, 'scope').weeklyRemaining, 20)
  assert.throws(() => normalizeCodexLimits({ rateLimitsByLimitId: {}, rateLimits: limits().rateLimitsByLimitId.codex }, 'scope'))
})
test('overconsumption clamps remaining to zero', () => {
  assert.equal(normalizeCodexLimits(limits({ primary: { ...short, usedPercent: 101 } }), 'scope').shortWindowRemaining, 0)
})
for (const patch of [
  { secondary: null }, { primary: { ...short, windowDurationMins: 15 } },
  { primary: { ...short, usedPercent: NaN } }, { primary: { ...short, usedPercent: null } },
  { primary: { ...short, resetsAt: '1792495260' } }, { primary: { ...short, resetsAt: -1 } },
  { primary: { ...short, usedPercent: -1 } }, { limitId: 'other' },
]) {
  test(`incomplete/invalid limits rejected: ${JSON.stringify(patch)}`, () => {
    assert.throws(() => normalizeCodexLimits(limits(patch), 'scope'))
  })
}
function server(reply) {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.killed = false
  child.kill = () => { child.killed = true; return true }
  const requests = []
  child.stdin = new Writable({
    write(chunk, encoding, callback) {
      const message = JSON.parse(chunk.toString())
      requests.push(message)
      queueMicrotask(() => {
        const response = reply(message, requests)
        if (response !== undefined) {
          // Split frames to exercise stream parsing and interleave an unsolicited notification.
          const frame = JSON.stringify({ id: message.id, ...response }) + '\n'
          child.stdout.write('{"method":"account/updated","params":{}}\n')
          child.stdout.write(frame.slice(0, 7))
          child.stdout.write(frame.slice(7))
        }
      })
      callback()
    },
  })
  return { child, requests, launch: () => child }
}
const successful = message => message.method === 'account/read' ? { result: account() }
  : message.method === 'account/rateLimits/read' ? { result: limits() }
    : message.method === 'initialize' ? { result: {} } : undefined
const run = (fake, options = {}) => readCodexQuota({ executable: 'fake', launch: fake.launch, scopeSalt: 'test-salt', timeoutMs: 500, ...options })

test('RPC handshake, safe fields, cleanup; no inference APIs or credentials', async () => {
  const fake = server(successful)
  const result = await run(fake)
  assert.equal(result.ok, true)
  assert.match(result.snapshot.scopeId, /^codex-[a-f0-9]{64}$/)
  assert.equal(result.snapshot.shortWindowRemaining, 75)
  assert.doesNotMatch(JSON.stringify(result), /fixture|example|email|planType/)
  assert.deepEqual(fake.requests.map(value => value.method), ['initialize', 'initialized', 'account/read', 'account/rateLimits/read', 'account/read'])
  assert.equal(fake.child.killed, true)
})
test('same local salt/account yields stable scope; different installation differs', async () => {
  const a = await run(server(successful)), b = await run(server(successful))
  const c = await run(server(successful), { scopeSalt: 'another-installation' })
  assert.equal(a.snapshot.scopeId, b.snapshot.scopeId)
  assert.notEqual(a.snapshot.scopeId, c.snapshot.scopeId)
})
test('login missing and API key auth rejected without querying limits', async () => {
  for (const [value, code] of [[null, 'LOGIN_REQUIRED'], [{ type: 'apiKey' }, 'UNSUPPORTED_ACCOUNT']]) {
    const fake = server(message => message.method === 'account/read' ? { result: { account: value } } : successful(message))
    const result = await run(fake)
    assert.equal(result.code, code)
    assert.ok(!fake.requests.some(value => value.method === 'account/rateLimits/read'))
  }
})
test('account changes during request discard quotas', async () => {
  let calls = 0
  const fake = server(message => message.method === 'account/read'
    ? { result: account(++calls === 1 ? 'one@example.invalid' : 'two@example.invalid') } : successful(message))
  const result = await run(fake)
  assert.equal(result.code, 'ACCOUNT_CHANGED')
  assert.equal(result.scopeId, undefined)
})
test('upstream RPC errors sanitized; verified identity retained for stale fallback', async () => {
  const fake = server(message => message.method === 'account/rateLimits/read'
    ? { error: { message: 'SECRET_TOKEN email@private.invalid', code: -1 } } : successful(message))
  const result = await run(fake)
  assert.equal(result.code, 'UNAVAILABLE')
  assert.match(result.scopeId, /^codex-/)
  assert.doesNotMatch(JSON.stringify(result), /SECRET|private|message/)
})
test('timeout kills child and never prints partial output', async () => {
  const fake = server(() => undefined)
  assert.equal((await run(fake, { timeoutMs: 10 })).code, 'TIMEOUT')
  assert.equal(fake.child.killed, true)
})
test('abort kills active child and pre-aborted requests never spawn', async () => {
  const fake = server(() => undefined), controller = new AbortController()
  const promise = run(fake, { signal: controller.signal })
  controller.abort()
  assert.equal((await promise).code, 'CANCELLED')
  assert.equal(fake.child.killed, true)
  let launched = false
  const result = await readCodexQuota({ executable: 'fake', scopeSalt: 'salt', signal: controller.signal, launch: () => { launched = true } })
  assert.equal(result.code, 'CANCELLED')
  assert.equal(launched, false)
})
test('malformed and oversized protocol output rejected and child closed', async () => {
  for (const text of ['invalid\n', 'x'.repeat(1_048_577)]) {
    const fake = server(() => undefined)
    const pending = run(fake)
    fake.child.stdout.write(text)
    assert.equal((await pending).code, 'INVALID_RESPONSE')
    assert.equal(fake.child.killed, true)
  }
})
test('spawn failure is sanitized', async () => {
  const fake = server(() => undefined), pending = run(fake)
  fake.child.emit('error', Error('private location'))
  assert.equal((await pending).code, 'UNAVAILABLE')
})
test('missing executable gives actionable code without launching a shell', async () => {
  await assert.rejects(findCodexExecutable({ PETCAST_CODEX_PATH: 'not-absolute.exe', PATH: '' }), error => error.code === 'CLI_NOT_FOUND')
})
test('upstream account ID is hashed and separates workspaces of the same login', async () => {
  const read = id => run(server(message => message.method === 'account/rateLimits/read'
    ? { result: { ...limits(), accountId: id } } : successful(message)))
  const a = await read('workspace-one'), b = await read('workspace-two'), again = await read('workspace-one')
  assert.equal(a.snapshot.scopeId, b.snapshot.scopeId)
  assert.notEqual(a.snapshot.accountScopeId, b.snapshot.accountScopeId)
  assert.equal(a.snapshot.accountScopeId, again.snapshot.accountScopeId)
  assert.doesNotMatch(JSON.stringify(a), /workspace-one|fixture@example/)
})
