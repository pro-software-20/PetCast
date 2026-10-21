import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadTs } from './load-ts.mjs'
const { UsageConnection } = await loadTs('../src/usage/UsageConnection.ts')
const { createMockUsageState } = await loadTs('../src/usage/MockUsageProvider.ts')
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }

test('source switch clears snapshot synchronously and ignores delayed real responses', async () => {
  let resolveReal, aborted = false
  const connection = new UsageConnection(source => ({source, getCurrentUsage: signal => source === 'real'
    ? new Promise(resolve => { resolveReal = resolve; signal.addEventListener('abort', () => { aborted = true }) })
    : Promise.resolve(createMockUsageState()) }))
  try {
    connection.start()
    assert.equal(connection.getSnapshot().refreshing, true)
    connection.select('mock')
    assert.equal(connection.getSnapshot().reading, null)
    assert.equal(aborted, true)
    await flush()
    assert.equal(connection.getSnapshot().reading.data.shortWindowRemaining, 68)
    resolveReal({...createMockUsageState(), shortWindowRemaining: 3})
    await flush()
    assert.equal(connection.getSnapshot().source, 'mock')
    assert.equal(connection.getSnapshot().reading.data.shortWindowRemaining, 68)
    connection.select('real')
    assert.equal(connection.getSnapshot().reading, null)
  } finally { connection.stop() }
})
test('manual refresh reports same-source stale, while switching destroys the real cache', async () => {
  let fails = false, calls = 0
  const connection = new UsageConnection(source => ({ source, cacheKey: 'same', getCurrentUsage: async () => {
    calls++
    if (fails) throw {code: 'UNAVAILABLE'}
    return {...createMockUsageState(), shortWindowRemaining: 37}
  }}))
  try {
    connection.start(); await flush()
    fails = true
    const a = connection.refresh(), b = connection.refresh()
    await Promise.all([a,b])
    assert.equal(calls, 2)
    assert.equal(connection.getSnapshot().reading.status, 'stale')
    assert.equal(connection.getSnapshot().reading.data.shortWindowRemaining, 37)
    connection.select('mock'); await flush()
    connection.select('real'); await flush()
    assert.equal(connection.getSnapshot().reading.status, 'unavailable')
    assert.equal(connection.getSnapshot().reading.data, null)
  } finally { connection.stop() }
})
test('strict-mode stop/start and unsubscribe do not publish obsolete reads', async () => {
  const resolvers = []
  let changes = 0
  const connection = new UsageConnection(source => ({source, getCurrentUsage: () => new Promise(resolve => resolvers.push(resolve))}))
  const unsubscribe = connection.subscribe(() => changes++)
  connection.start(); connection.stop(); connection.start()
  const before = changes
  resolvers[0](createMockUsageState()); await flush()
  assert.equal(changes, before)
  resolvers[1](createMockUsageState()); await flush()
  assert.equal(connection.getSnapshot().reading.status, 'fresh')
  unsubscribe(); connection.stop()
  const after = changes
  connection.select('mock')
  assert.equal(changes, after)
})
