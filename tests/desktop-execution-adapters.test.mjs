import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTs } from './load-ts.mjs'

const {
  createDesktopCoordinationAdapterRegistry,
  isDeepSeekExecutionBridge,
} = await loadTs('../src/orchestration/desktopExecutionAdapters.ts')

const bridge = {
  async dispatchDeepSeekExecution() { return { ok: false, error: { code: 'UNAVAILABLE', retryable: true, message: 'fixture' } } },
  async inspectDeepSeekExecution() { return { ok: false, error: { code: 'EXECUTION_NOT_FOUND', retryable: false, message: 'fixture' } } },
  async cancelDeepSeekExecution() { return { ok: false, error: { code: 'CANCELLED', retryable: false, message: 'fixture' } } },
}

test('desktop registry exposes A DeepSeek adapter only through the complete trusted bridge', () => {
  assert.equal(isDeepSeekExecutionBridge(bridge), true)
  assert.ok(createDesktopCoordinationAdapterRegistry(bridge).get('deepseek'))
  assert.equal(createDesktopCoordinationAdapterRegistry({ dispatchDeepSeekExecution: bridge.dispatchDeepSeekExecution }).get('deepseek'), undefined)
  assert.equal(createDesktopCoordinationAdapterRegistry(undefined).get('deepseek'), undefined)
})

test('bridge availability checks neither mutate nor reveal local configuration', () => {
  const source = { ...bridge }
  assert.equal(isDeepSeekExecutionBridge(bridge), true)
  assert.deepEqual(bridge, source)
  assert.doesNotMatch(JSON.stringify(createDesktopCoordinationAdapterRegistry(bridge)), /DEEPSEEK_API_KEY|secret|token/i)
})
