import test from 'node:test'
import assert from 'node:assert/strict'
import { loadTs } from './load-ts.mjs'
const { resolveUsageSource } = await loadTs('../src/usage/usageSourcePreference.ts')
const { UsageConnection } = await loadTs('../src/usage/UsageConnection.ts')

test('desktop migrates legacy mock selection to real, browser fixtures remain explicit', () => {
  for (const saved of ['mock', 'real', null, 'invalid']) assert.equal(resolveUsageSource(true, saved), 'real')
  assert.equal(resolveUsageSource(false, 'mock'), 'mock')
  assert.equal(resolveUsageSource(false, null), 'real')
})

test('legacy desktop mock preference cannot supply full demo quota after real read fails', async () => {
  const selected = []
  const connection = new UsageConnection(source => {
    selected.push(source)
    return { source, getCurrentUsage: async () => { throw { code: 'UNAVAILABLE' } } }
  }, resolveUsageSource(true, 'mock'))
  try {
    connection.start()
    await connection.refresh()
    assert.deepEqual(selected, ['real'])
    assert.equal(connection.getSnapshot().reading.status, 'unavailable')
    assert.equal(connection.getSnapshot().reading.data, null)
  } finally { connection.stop() }
})
