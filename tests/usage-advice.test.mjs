import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadTs } from './load-ts.mjs'
const { analyzeUsage, formatResetStatus, resetConfirmationMessage } = await loadTs('../src/game/usageAnalysis.ts')
const now = new Date('2026-10-22T10:00:00.000Z')
const usage = { sampledAt: now, shortWindowRemaining: 95, weeklyRemaining: 60,
  shortWindowResetAt: new Date(+now + 5 * 3600000), weeklyResetAt: new Date(+now + 4 * 86400000),
  burnRate: null, baselineBurnRate: null, recentResetType: null }

test('a reset never overrides the other quota window at zero or low balance', () => {
  for (const weeklyRemaining of [0, 8, 22]) {
    const sample = { ...usage, weeklyRemaining, recentResetType: 'short' }
    const result = analyzeUsage(sample, now)
    assert.equal(result.primary, 'weeklyLow')
    assert.doesNotMatch(result.message, /适合.*任务|额度充足/)
    assert.match(resetConfirmationMessage(sample), /仍有额度处于低位/)
  }
  for (const shortWindowRemaining of [0, 10, 25]) {
    const result = analyzeUsage({ ...usage, shortWindowRemaining, recentResetType: 'weekly' }, now)
    assert.equal(result.primary, 'shortLow')
  }
})

test('elapsed boundaries wait for confirmation and never imply quota refill', () => {
  for (const field of ['shortWindowResetAt', 'weeklyResetAt']) {
    for (const offset of [0, -60000]) {
      const sample = { ...usage, [field]: new Date(+now + offset), shortWindowRemaining: 0 }
      const result = analyzeUsage(sample, now)
      assert.equal(result.primary, 'resetPending')
      assert.match(result.message, /尚未确认/)
      assert.doesNotMatch(result.message, /就会恢复|0 分钟后/)
      assert.match(field === 'shortWindowResetAt' ? result.shortResetText : result.weeklyResetText, /待确认/)
      assert.equal(sample.shortWindowRemaining, 0)
    }
  }
})

test('future countdowns are estimates and do not round a positive interval down to zero', () => {
  assert.match(formatResetStatus(new Date(+now + 1000), now), /预计 1 分钟/)
  const result = analyzeUsage({ ...usage, shortWindowRemaining: 0, shortWindowResetAt: new Date(+now + 1000) }, now)
  assert.match(result.message, /预计.*重新读取确认/)
})

test('healthy quota and resets do not independently recommend a large task', () => {
  for (const recentResetType of [null, 'short', 'weekly']) {
    const result = analyzeUsage({ ...usage, recentResetType }, now)
    assert.doesNotMatch(result.message, /适合.*任务/)
    assert.match(result.message, /任务|期限/)
  }
})

test('session rate comparison is not described as long-term user habits', () => {
  const result = analyzeUsage({ ...usage, burnRate: 20, baselineBurnRate: 5 }, now)
  assert.equal(result.primary, 'accelerating')
  assert.match(result.message, /本次连续观测/)
  assert.doesNotMatch(result.message, /高于平时/)
})
