import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadTs } from './load-ts.mjs'
const { analyzeUsage } = await loadTs('../src/game/usageAnalysis.ts')
const { deriveRiverEnvironment } = await loadTs('../src/game/riverEnvironment.ts')
const { classifyFishingPattern } = await loadTs('../src/game/fishingEngine.ts')
const { createGameSave, restoreGameSave } = await loadTs('../src/persistence/storage.ts')
const now = new Date('2026-10-20T10:00:00Z')
const usage = {
  shortWindowRemaining: 70, weeklyRemaining: 70, burnRate: null, baselineBurnRate: null,
  sampledAt: now, shortWindowResetAt: new Date(+now + 3_600_000), weeklyResetAt: new Date(+now + 300_000_000),
  recentResetType: null,
}
test('unknown rates do not trigger acceleration or burst fishing', () => {
  assert.ok(!analyzeUsage(usage, now).flags.includes('accelerating'))
  assert.ok(!classifyFishingPattern(usage, now).tags.includes('burst'))
  assert.equal(deriveRiverEnvironment(usage, now).flowLabel, '速度数据不足')
  assert.ok(Number.isFinite(deriveRiverEnvironment(usage, now).flowDurationSeconds))
})
test('game save round trip preserves unknown rates as null', () => {
  const save = createGameSave({ usage, aquarium: [], codex: {}, mailItems: [], unreadMailIds: [],
    autoFishingEnabled: false, resetWatchEnabled: false })
  const restored = restoreGameSave(JSON.parse(JSON.stringify(save)), usage)
  assert.equal(restored.usage.burnRate, null)
  assert.equal(restored.usage.baselineBurnRate, null)
})
