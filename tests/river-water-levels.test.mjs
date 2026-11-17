import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadTs } from './load-ts.mjs'

const { deriveRiverEnvironment } = await loadTs('../src/game/riverEnvironment.ts')
const now = new Date('2026-10-20T10:00:00Z')

const usageAt = weeklyRemaining => ({
  shortWindowRemaining: 70,
  weeklyRemaining,
  burnRate: null,
  baselineBurnRate: null,
  sampledAt: now,
  shortWindowResetAt: new Date(+now + 3_600_000),
  weeklyResetAt: new Date(+now + 300_000_000),
  recentResetType: null,
})

test('weekly remaining maps to four river-contained water tiers', () => {
  const cases = [
    [0, 1, 84, 9],
    [24.9, 1, 84, 9],
    [25, 2, 81, 6],
    [49.9, 2, 81, 6],
    [50, 3, 78, 3],
    [74.9, 3, 78, 3],
    [75, 4, 75.5, 0],
    [100, 4, 75.5, 0],
  ]

  for (const [remaining, tier, top, recede] of cases) {
    const environment = deriveRiverEnvironment(usageAt(remaining), now)
    assert.equal(environment.waterTier, tier, `${remaining}% tier`)
    assert.equal(environment.waterTopPercent, top, `${remaining}% water top`)
    assert.equal(environment.waterRecedePercent, recede, `${remaining}% recede mask`)
  }
})

test('higher weekly remaining never lowers the visible water surface', () => {
  const tops = [12, 37, 62, 87].map(remaining => deriveRiverEnvironment(usageAt(remaining), now).waterTopPercent)
  assert.deepEqual(tops, [84, 81, 78, 75.5])
  assert.ok(tops.every((top, index) => index === 0 || top < tops[index - 1]))
})
