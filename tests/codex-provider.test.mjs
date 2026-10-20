import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadTs } from './load-ts.mjs'
const { CodexUsageProvider } = await loadTs('../src/usage/CodexUsageProvider.ts')
const { UsageReader } = await loadTs('../src/usage/UsageReader.ts')
const { createUsageSession } = await loadTs('../src/usage/providerFactory.ts')
const scope = 'codex-' + 'a'.repeat(64)
const raw = (patch = {}) => ({
  scopeId: scope, sampledAt: '2026-10-20T02:00:00.000Z',
  shortWindowRemaining: 42, weeklyRemaining: 55,
  shortWindowResetAt: '2026-10-20T04:00:00.000Z', weeklyResetAt: '2026-10-25T02:00:00.000Z',
  ...patch,
})
const ok = (patch) => ({ ok: true, snapshot: raw(patch) })
const providerWith = (...results) => new CodexUsageProvider({
  readCodexUsage: async () => results.shift(), cancelCodexUsage: () => {},
})
test('first sample has real quotas and unknown rates, dates decoded', async () => {
  const result = await providerWith(ok()).getCurrentUsage()
  assert.equal(result.shortWindowRemaining, 42)
  assert.equal(result.burnRate, null)
  assert.equal(result.baselineBurnRate, null)
  assert.equal(result.scopeId, scope)
  assert.ok(result.sampledAt instanceof Date)
})
test('rate uses actual interval; baseline excludes current interval', async () => {
  const provider = providerWith(ok(), ok({ sampledAt: '2026-10-20T02:02:00.000Z', shortWindowRemaining: 40 }),
    ok({ sampledAt: '2026-10-20T02:03:00.000Z', shortWindowRemaining: 37 }))
  await provider.getCurrentUsage()
  const second = await provider.getCurrentUsage(), third = await provider.getCurrentUsage()
  assert.equal(second.burnRate, 60)
  assert.equal(second.baselineBurnRate, null)
  assert.equal(third.burnRate, 180)
  assert.equal(third.baselineBurnRate, 60)
})
for (const patch of [
  { sampledAt: '2026-10-20T02:06:00.000Z', shortWindowRemaining: 40 },
  { sampledAt: '2026-10-20T02:01:00.000Z', shortWindowRemaining: 43 },
  { sampledAt: '2026-10-20T02:01:00.000Z', shortWindowResetAt: '2026-10-20T05:00:00.000Z' },
  { sampledAt: '2026-10-20T02:01:00.000Z', scopeId: 'codex-' + 'b'.repeat(64) },
]) {
  test(`break rate continuity: ${JSON.stringify(patch)}`, async () => {
    const provider = providerWith(ok(), ok(patch))
    await provider.getCurrentUsage()
    const result = await provider.getCurrentUsage()
    assert.equal(result.burnRate, null)
    assert.equal(result.baselineBurnRate, null)
    assert.equal(result.recentResetType, null)
  })
}
test('confirmed reset needs an advanced elapsed boundary and an increase', async () => {
  const provider = providerWith(ok(), ok({
    sampledAt: '2026-10-20T04:01:00.000Z', shortWindowRemaining: 96,
    shortWindowResetAt: '2026-10-20T09:00:00.000Z',
  }), ok({
    sampledAt: '2026-10-20T04:02:00.000Z', shortWindowRemaining: 95,
    shortWindowResetAt: '2026-10-20T09:00:00.000Z',
  }))
  await provider.getCurrentUsage()
  assert.equal((await provider.getCurrentUsage()).recentResetType, 'short')
  assert.equal((await provider.getCurrentUsage()).recentResetType, null)
})
test('elapsed clock alone never refills quota', async () => {
  const provider = providerWith(ok(), ok({ sampledAt: '2026-10-20T04:01:00.000Z', shortWindowRemaining: 0 }))
  await provider.getCurrentUsage()
  const result = await provider.getCurrentUsage()
  assert.equal(result.shortWindowRemaining, 0)
  assert.equal(result.recentResetType, null)
})
test('transient failure with verified same account returns stale real data', async () => {
  const reader = new UsageReader(providerWith(ok(), { ok: false, code: 'TIMEOUT', scopeId: scope }))
  const first = await reader.read(), second = await reader.read()
  assert.equal(second.status, 'stale')
  assert.equal(+second.data.sampledAt, +first.data.sampledAt)
  assert.equal(second.source, 'real')
})
for (const failure of [
  { ok: false, code: 'LOGIN_REQUIRED' },
  { ok: false, code: 'UNAVAILABLE', scopeId: 'codex-' + 'b'.repeat(64) },
  { ok: false, code: 'UNSUPPORTED_WINDOWS', scopeId: scope },
  { ok: false, code: 'ACCOUNT_CHANGED' },
]) {
  test(`do not show old account data: ${failure.code}`, async () => {
    const reader = new UsageReader(providerWith(ok(), failure))
    await reader.read()
    assert.equal((await reader.read()).status, 'unavailable')
  })
}
for (const patch of [{ shortWindowRemaining: NaN }, { weeklyRemaining: -1 }, { sampledAt: 'invalid' }, { scopeId: 'private-email' }]) {
  test('invalid bridge payload rejected', async () => {
    const reader = new UsageReader(providerWith(ok(patch)))
    assert.equal((await reader.read()).status, 'unavailable')
  })
}
test('duplicate timestamp cannot become fresh history or overwrite rate state', async () => {
  const provider = providerWith(ok(), ok())
  await provider.getCurrentUsage()
  await assert.rejects(provider.getCurrentUsage(), error => error.code === 'INVALID_RESPONSE')
})
test('cancellation reaches main bridge, late response ignored', async () => {
  let complete, cancelledId, startedId
  const provider = new CodexUsageProvider({
    readCodexUsage: id => { startedId = id; return new Promise(resolve => { complete = resolve }) },
    cancelCodexUsage: id => { cancelledId = id },
  })
  const controller = new AbortController()
  const pending = provider.getCurrentUsage(controller.signal)
  controller.abort()
  await assert.rejects(pending, error => error.code === 'CANCELLED')
  assert.equal(cancelledId, startedId)
  complete(ok())
  await Promise.resolve()
  assert.match(provider.cacheKey, /^unverified-/)
})
test('factory never silently switches to mock when desktop bridge missing', async () => {
  const real = createUsageSession('real')
  assert.equal((await real.reader.read()).status, 'unavailable')
  assert.equal(real.provider.source, 'real')
  const mock = createUsageSession('mock')
  assert.equal((await mock.reader.read()).status, 'fresh')
  assert.equal(mock.provider.source, 'mock')
})

test('same login with different workspace never mixes rate history', async () => {
  const accountA = 'codex-' + '1'.repeat(64), accountB = 'codex-' + '2'.repeat(64)
  const provider = providerWith(ok({ accountScopeId: accountA }), ok({
    accountScopeId: accountB, sampledAt: '2026-10-20T02:01:00.000Z', shortWindowRemaining: 10,
  }))
  const first = await provider.getCurrentUsage(), second = await provider.getCurrentUsage()
  assert.equal(first.scopeId, accountA)
  assert.equal(second.scopeId, accountB)
  assert.equal(second.burnRate, null)
  assert.equal(second.recentResetType, null)
})
test('workspace cache is retained only as stale on a transient failure; known workspace switch clears it', async () => {
  const accountA = 'codex-' + '1'.repeat(64), accountB = 'codex-' + '2'.repeat(64)
  const reader = new UsageReader(providerWith(ok({ accountScopeId: accountA }),
    { ok: false, code: 'TIMEOUT', scopeId: scope },
    { ok: false, code: 'UNAVAILABLE', scopeId: scope, accountScopeId: accountB }))
  await reader.read()
  const cached = await reader.read()
  assert.equal(cached.status, 'stale')
  assert.equal(cached.data.scopeId, accountA)
  assert.equal((await reader.read()).status, 'unavailable')
})
test('impossible calendar date cannot silently roll into the next month', async () => {
  const result = await new UsageReader(providerWith(ok({ sampledAt: '2026-02-30T02:00:00.000Z' }))).read()
  assert.equal(result.status, 'unavailable')
})
test('malformed workspace scope never passes through the bridge', async () => {
  const result = await new UsageReader(providerWith(ok({ accountScopeId: 'private-account-id' }))).read()
  assert.equal(result.status, 'unavailable')
})
test('consumer mutation cannot corrupt provider rate history', async () => {
  const provider = providerWith(ok(), ok({ sampledAt: '2026-10-20T02:01:00.000Z', shortWindowRemaining: 41 }))
  const first = await provider.getCurrentUsage()
  first.sampledAt.setFullYear(2099)
  first.shortWindowResetAt.setFullYear(2099)
  const second = await provider.getCurrentUsage()
  assert.equal(second.burnRate, 60)
})
test('provider accepts immediate retry after cancellation without late request interference', async () => {
  let calls = 0, finish
  const provider = new CodexUsageProvider({
    readCodexUsage: () => {
      if (calls++) return Promise.resolve(ok())
      return new Promise(resolve => { finish = resolve })
    },
    cancelCodexUsage() {},
  })
  const controller = new AbortController()
  const cancelled = provider.getCurrentUsage(controller.signal).catch(error => error.code)
  controller.abort()
  const next = await provider.getCurrentUsage()
  finish(ok({ scopeId: 'codex-' + 'b'.repeat(64) }))
  assert.equal(await cancelled, 'CANCELLED')
  await Promise.resolve()
  assert.equal(next.scopeId, scope)
  assert.equal(provider.cacheKey, scope)
})
test('Reader and real Provider together support cancel then immediate retry', async () => {
  let calls = 0, finish
  const provider = new CodexUsageProvider({
    readCodexUsage: () => {
      if (calls++) return Promise.resolve(ok())
      return new Promise(resolve => { finish = resolve })
    }, cancelCodexUsage() {},
  })
  const reader = new UsageReader(provider)
  const first = reader.read()
  reader.cancel()
  const second = await reader.read()
  finish(ok({ scopeId: 'codex-' + 'b'.repeat(64) }))
  assert.equal((await first).status, 'unavailable')
  assert.equal(second.status, 'fresh')
  assert.equal(second.data.scopeId, scope)
  assert.equal(provider.cacheKey, scope)
})
