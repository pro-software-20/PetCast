import test from 'node:test'
import assert from 'node:assert/strict'
import { loadTs } from './load-ts.mjs'
const { CodexQueueAdapter } = await loadTs('../src/orchestration/CodexQueueAdapter.ts')
const { FakeDeepSeekExecutionClient, createDeepSeekExecutionConformanceRequest } = await loadTs('../src/orchestration/deepSeekExecutionFixture.ts')
const { prepareDeepSeekBatch } = await loadTs('../src/orchestration/batchExecutionSetup.ts')

test('Codex adapter uses local-agent and preserves Codex identity without duplicate execution', async () => {
  const client = new FakeDeepSeekExecutionClient('completed')
  const adapter = new CodexQueueAdapter(client)
  const request = createDeepSeekExecutionConformanceRequest()
  request.providerId = 'codex'; request.task.executionMode = 'local-agent'
  const before = structuredClone(request)
  const receipt = await adapter.dispatch(request)
  assert.equal(receipt.ok,true,JSON.stringify(receipt))
  assert.deepEqual(await adapter.dispatch(request),receipt)
  assert.equal(client.providerStartCallCount,1)
  const { dispatchId, adapterExecutionId, taskId } = receipt.value
  const result = await adapter.inspect({ dispatchId, adapterExecutionId, taskId })
  assert.equal(result.ok,true)
  assert.equal(result.value.result.providerId,'codex')
  assert.deepEqual(request,before)
})

test('Codex queue rejects unauthorized file scope and API execution mode', async () => {
  const client = new FakeDeepSeekExecutionClient('completed')
  const adapter = new CodexQueueAdapter(client)
  const request = createDeepSeekExecutionConformanceRequest()
  request.providerId = 'codex'
  assert.equal((await adapter.dispatch(request)).ok,false)
  request.task.executionMode = 'local-agent'
  request.task.files.allowedWritePaths = ['src']
  assert.equal((await adapter.dispatch(request)).ok,false)
  assert.equal(client.providerStartCallCount,0)
})
