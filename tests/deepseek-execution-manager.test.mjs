import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { loadTs } from './load-ts.mjs'

const { DeepSeekExecutionManager } = await loadTs('../electron/deepSeekExecutionManager.ts')

const request = {
  dispatchId: 'dispatch-1',
  taskId: 'task-1',
  title: 'Review a design',
  description: 'Review the supplied design summary.',
  prompt: 'Return concise findings.',
  dependencySummaries: [],
  acceptanceChecks: ['Findings are clear'],
}

const inspectUntilTerminal = async (manager, reference) => {
  for (let index = 0; index < 30; index += 1) {
    const inspected = await manager.inspect(reference)
    if (inspected.ok && !['queued', 'running'].includes(inspected.value.state)) return inspected
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  throw new Error('execution did not finish')
}

test('real DeepSeek manager persists a completed result and deduplicates dispatch', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'petcast-deepseek-test-'))
  const file = path.join(directory, 'executions.json')
  let providerCalls = 0
  const fakeFetch = async () => {
    providerCalls += 1
    return new Response(JSON.stringify({
      choices: [{ message: { content: 'Completed output.' } }],
      usage: { prompt_tokens: 12, completion_tokens: 4 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    const manager = new DeepSeekExecutionManager(file, { apiKey: 'test-only', fetchImpl: fakeFetch })
    const first = await manager.dispatch(request)
    const duplicate = await manager.dispatch(structuredClone(request))
    assert.equal(first.ok, true)
    assert.deepEqual(duplicate, first)
    const reference = {
      dispatchId: first.value.dispatchId,
      adapterExecutionId: first.value.adapterExecutionId,
      taskId: first.value.taskId,
    }
    const completed = await inspectUntilTerminal(manager, reference)
    assert.equal(completed.ok, true)
    assert.equal(completed.value.state, 'completed')
    assert.equal(completed.value.result.outputText, 'Completed output.')
    assert.equal(providerCalls, 1)

    const reopened = new DeepSeekExecutionManager(file, { apiKey: 'test-only', fetchImpl: fakeFetch })
    const recovered = await reopened.inspect(reference)
    assert.equal(recovered.ok, true)
    assert.equal(recovered.value.state, 'completed')
    assert.equal(providerCalls, 1)
    await manager.dispose()
    await reopened.dispose()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('manager never calls DeepSeek when durable intent cannot be configured', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'petcast-deepseek-test-'))
  const file = path.join(directory, 'executions.json')
  let providerCalls = 0
  try {
    const manager = new DeepSeekExecutionManager(file, {
      fetchImpl: async () => { providerCalls += 1; throw new Error('must not run') },
    })
    const outcome = await manager.dispatch(request)
    assert.equal(outcome.ok, false)
    assert.equal(outcome.error.code, 'UNAVAILABLE')
    assert.equal(providerCalls, 0)
    assert.doesNotMatch(JSON.stringify(outcome), /api[_ -]?key|authorization|test-only/i)
    await manager.dispose()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
