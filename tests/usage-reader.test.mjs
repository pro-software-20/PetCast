import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadTs } from './load-ts.mjs'
const { UsageReader } = await loadTs('../src/usage/UsageReader.ts')
const snapshot = () => ({ shortWindowRemaining: 42, weeklyRemaining: 55,
  shortWindowResetAt: new Date('2026-10-21T02:00:00Z'), weeklyResetAt: new Date('2026-10-25T02:00:00Z'),
  burnRate: 3, baselineBurnRate: 2, sampledAt: new Date('2026-10-20T02:00:00Z'), recentResetType: null })

test('successful real read preserves source timestamp', async () => {
  const data = snapshot()
  const result = await new UsageReader({ source: 'real', getCurrentUsage: async () => data }).read()
  assert.equal(result.status, 'fresh')
  assert.equal(result.source, 'real')
  assert.equal(result.data.sampledAt.getTime(), data.sampledAt.getTime())
})
test('cold failure is unavailable and never creates mock data or leaks provider error', async () => {
  const result = await new UsageReader({ source: 'real', getCurrentUsage: async () => { throw Error('secret') } }).read()
  assert.equal(result.status, 'unavailable')
  assert.equal(result.source, 'real')
  assert.equal(result.data, null)
  assert.doesNotMatch(result.error, /secret/)
})
test('warm failure preserves sample timestamp without replaying reset event', async () => {
  let calls = 0
  const data = { ...snapshot(), recentResetType: 'short' }
  const reader = new UsageReader({ source: 'real', getCurrentUsage: async () => { if (calls++) throw Error(); return data } })
  await reader.read()
  const result = await reader.read()
  assert.equal(result.status, 'stale')
  assert.equal(result.data.sampledAt.getTime(), data.sampledAt.getTime())
  assert.equal(result.data.recentResetType, null)
})
test('simultaneous callers share one request', async () => {
  let calls = 0
  const reader = new UsageReader({ source: 'mock', getCurrentUsage: async () => { calls++; return snapshot() } })
  const first = reader.read()
  const second = reader.read()
  assert.equal(first, second)
  await Promise.all([first, second])
  assert.equal(calls, 1)
})
test('timeout aborts request; late completion cannot overwrite next success', async () => {
  let resolveLate, signal, calls = 0
  const reader = new UsageReader({ source: 'real', getCurrentUsage: async (s) => {
    if (calls++) return { ...snapshot(), shortWindowRemaining: 12 }
    signal = s
    return new Promise(resolve => { resolveLate = resolve })
  } }, 10)
  assert.equal((await reader.read()).status, 'unavailable')
  assert.equal(signal.aborted, true)
  assert.equal((await reader.read()).data.shortWindowRemaining, 12)
  resolveLate(snapshot())
  await Promise.resolve()
  assert.equal((await reader.read()).data.shortWindowRemaining, 12)
})
for (const patch of [{ shortWindowRemaining: NaN }, { weeklyRemaining: 101 }, { burnRate: -1 }, { sampledAt: '2026-10-20' }, { recentResetType: 'invalid' }]) {
  test(`invalid snapshot rejected: ${Object.keys(patch)[0]}`, async () => {
    const result = await new UsageReader({ source: 'real', getCurrentUsage: async () => ({ ...snapshot(), ...patch }) }).read()
    assert.equal(result.status, 'unavailable')
    assert.equal(result.data, null)
  })
}

test('unknown rates accepted without inventing zero', async () => {
  const data = { ...snapshot(), burnRate: null, baselineBurnRate: null }
  const result = await new UsageReader({ source: 'real', getCurrentUsage: async () => data }).read()
  assert.equal(result.status, 'fresh')
  assert.equal(result.data.burnRate, null)
})
test('scope change discards another account cache even on failure', async () => {
  const provider = { source: 'real', cacheKey: 'account-a', getCurrentUsage: async () => snapshot() }
  const reader = new UsageReader(provider)
  await reader.read()
  provider.getCurrentUsage = async () => { provider.cacheKey = 'account-b'; throw Error('secret') }
  assert.equal((await reader.read()).status, 'unavailable')
})

test('explicit cancel rejects a late result even if provider ignores AbortSignal', async () => {
  let finish
  const reader = new UsageReader({ source: 'real', getCurrentUsage: () => new Promise(resolve => { finish = resolve }) }, 100)
  const pending = reader.read()
  reader.cancel()
  finish(snapshot())
  assert.equal((await pending).status, 'unavailable')
})
test('cancel allows an immediate new read; late old result cannot replace it', async () => {
  let finish, calls = 0
  const reader = new UsageReader({ source: 'real', getCurrentUsage: () => {
    if (calls++) return Promise.resolve({ ...snapshot(), shortWindowRemaining: 12 })
    return new Promise(resolve => { finish = resolve })
  } }, 100)
  const first = reader.read()
  reader.cancel()
  const second = reader.read()
  finish(snapshot())
  assert.notEqual(first, second)
  assert.equal((await second).data.shortWindowRemaining, 12)
  assert.equal((await first).status, 'unavailable')
})
test('mutating a fresh result cannot alter the cached sample dates', async () => {
  let calls = 0
  const reader = new UsageReader({ source: 'real', getCurrentUsage: async () => {
    if (calls++) throw Error()
    return snapshot()
  } })
  const first = await reader.read()
  first.data.sampledAt.setTime(0)
  const cached = await reader.read()
  assert.equal(+cached.data.sampledAt, +snapshot().sampledAt)
})
test('mutating a stale result cannot alter subsequent cached values', async () => {
  let calls = 0
  const reader = new UsageReader({ source: 'real', getCurrentUsage: async () => {
    if (calls++) throw Error()
    return snapshot()
  } })
  await reader.read()
  const stale = await reader.read()
  stale.data.shortWindowRemaining = 0
  stale.data.weeklyResetAt.setTime(0)
  const again = await reader.read()
  assert.equal(again.data.shortWindowRemaining, 42)
  assert.equal(+again.data.weeklyResetAt, +snapshot().weeklyResetAt)
})
