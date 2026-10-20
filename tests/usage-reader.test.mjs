import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const source = await readFile(new URL('../src/usage/UsageReader.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
const { UsageReader } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
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
