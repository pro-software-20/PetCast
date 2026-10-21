import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadTs } from './load-ts.mjs'
const { startUsagePolling } = await loadTs('../src/usage/usagePolling.ts')
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
const unavailable = () => ({ source: 'real', status: 'unavailable', data: null, checkedAt: new Date(), error: 'offline' })

test('polling waits after completion, coalesces manual refresh and stops cleanly', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 })
  let resolve, calls = 0, cancelled = 0
  const reader = {
    read: () => { calls++; return new Promise(done => { resolve = done }) },
    cancel: () => { cancelled++ },
  }
  const received = []
  const polling = startUsagePolling(reader, value => received.push(value))
  const a = polling.refresh(), b = polling.refresh()
  assert.equal(a, b)
  t.mock.timers.tick(60_000)
  assert.equal(calls, 1)
  resolve(unavailable())
  await flush()
  t.mock.timers.tick(29_999)
  assert.equal(calls, 1)
  t.mock.timers.tick(1)
  assert.equal(calls, 2)
  polling.stop()
  resolve(unavailable())
  await flush()
  t.mock.timers.tick(60_000)
  assert.equal(calls, 2)
  assert.equal(received.length, 1)
  assert.equal(cancelled, 1)
})
test('upcoming reset causes a query, elapsed reset does not cause a tight loop', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 })
  let calls = 0
  const reader = {
    read: async () => {
      calls++
      return { source: 'real', status: 'fresh', error: null, checkedAt: new Date(),
        data: { shortWindowResetAt: new Date(6000), weeklyResetAt: new Date(200_000) } }
    }, cancel() {},
  }
  const polling = startUsagePolling(reader, () => {})
  await flush()
  t.mock.timers.tick(4999)
  assert.equal(calls, 1)
  t.mock.timers.tick(1)
  await flush()
  assert.equal(calls, 2)
  t.mock.timers.tick(29_999)
  assert.equal(calls, 2)
  t.mock.timers.tick(1)
  await flush()
  assert.equal(calls, 3)
  polling.stop()
})
test('stopping an old poller twice cannot cancel a replacement session', async () => {
  let cancelled = 0
  const reader = { read: async () => unavailable(), cancel: () => { cancelled++ } }
  const old = startUsagePolling(reader, () => {})
  old.stop()
  const replacement = startUsagePolling(reader, () => {})
  old.stop()
  assert.equal(cancelled, 1)
  replacement.stop()
})
test('background callback errors are handled; manual refresh rejects and later polls recover', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 })
  let callbacks = 0
  const reader = { read: async () => unavailable(), cancel() {} }
  const polling = startUsagePolling(reader, () => {
    callbacks++
    if (callbacks <= 2) throw Error('ui-failed')
  })
  await assert.rejects(polling.refresh(), /ui-failed/)
  t.mock.timers.tick(30_000)
  await flush()
  await new Promise(resolve => setImmediate(resolve))
  t.mock.timers.tick(30_000)
  await flush()
  assert.equal(callbacks, 3)
  polling.stop()
})
