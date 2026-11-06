import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTs } from './load-ts.mjs'

const { runExecutionAdapterConformance } = await loadTs('../src/orchestration/adapterConformance.ts')
const {
  createInMemoryExecutionAdapterConformanceFixture,
} = await loadTs('../src/orchestration/executionAdapterFixtures.ts')

test('standard in-memory adapter passes the complete zero-network conformance suite', async () => {
  const fixture = createInMemoryExecutionAdapterConformanceFixture()
  const request = fixture.createRequest()
  const before = structuredClone(request)
  const report = await runExecutionAdapterConformance({ ...fixture, createRequest: () => request })

  assert.equal(report.passed, true)
  assert.equal(report.providerId, 'deepseek')
  assert.equal(report.executionMode, 'api')
  assert.deepEqual(request, before)
  assert.ok(report.checks.length >= 14)
  assert.ok(report.checks.every(check => check.passed))
})

test('report contains only safe summaries and never copies adapter error payloads', async () => {
  const fixture = createInMemoryExecutionAdapterConformanceFixture()
  const originalCreateAdapter = fixture.createAdapter
  const report = await runExecutionAdapterConformance({
    ...fixture,
    createAdapter(scenario) {
      const adapter = originalCreateAdapter(scenario)
      if (scenario !== 'failed') return adapter
      return {
        dispatch: adapter.dispatch.bind(adapter),
        cancel: adapter.cancel.bind(adapter),
        async inspect(reference, signal) {
          const outcome = await adapter.inspect(reference, signal)
          if (outcome.ok && outcome.value.state === 'failed') {
            return {
              ok: true,
              value: {
                ...outcome.value,
                error: {
                  code: 'FAILED',
                  retryable: false,
                  message: 'Bearer secret-token at C:\\Users\\private\\provider-response.json',
                },
              },
            }
          }
          return outcome
        },
      }
    },
  })

  assert.equal(report.passed, false)
  assert.equal(report.checks.find(check => check.id === 'state.failed')?.passed, false)
  const serialized = JSON.stringify(report)
  assert.doesNotMatch(serialized, /secret-token|C:\\Users|provider-response/i)
})

test('runner detects request mutation without mutating the source fixture itself', async () => {
  const fixture = createInMemoryExecutionAdapterConformanceFixture()
  const originalCreateAdapter = fixture.createAdapter
  const sourceRequest = fixture.createRequest()
  const before = structuredClone(sourceRequest)
  const report = await runExecutionAdapterConformance({
    ...fixture,
    createRequest: () => structuredClone(sourceRequest),
    createAdapter(scenario) {
      const adapter = originalCreateAdapter(scenario)
      return {
        dispatch(request, signal) {
          request.task.title = 'mutated by adapter'
          return adapter.dispatch(request, signal)
        },
        inspect: adapter.inspect.bind(adapter),
        cancel: adapter.cancel.bind(adapter),
      }
    },
  })

  assert.equal(report.passed, false)
  assert.equal(report.checks.find(check => check.id === 'immutability.requests')?.passed, false)
  assert.deepEqual(sourceRequest, before)
})

test('standard fixture rejects a conflicting dispatch id', async () => {
  const fixture = createInMemoryExecutionAdapterConformanceFixture()
  const report = await runExecutionAdapterConformance(fixture)
  assert.equal(report.checks.find(check => check.id === 'dispatch.conflict')?.passed, true)
})

test('runner rejects receipts with unknown fields', async () => {
  const fixture = createInMemoryExecutionAdapterConformanceFixture()
  const originalCreateAdapter = fixture.createAdapter
  const report = await runExecutionAdapterConformance({
    ...fixture,
    createAdapter(scenario) {
      const adapter = originalCreateAdapter(scenario)
      if (scenario !== 'complete') return adapter
      return {
        async dispatch(request, signal) {
          const outcome = await adapter.dispatch(request, signal)
          return outcome.ok
            ? { ok: true, value: { ...outcome.value, providerPayload: 'not allowed' } }
            : outcome
        },
        inspect: adapter.inspect.bind(adapter),
        cancel: adapter.cancel.bind(adapter),
      }
    },
  })

  assert.equal(report.passed, false)
  assert.equal(report.checks.find(check => check.id === 'dispatch.receipt')?.passed, false)
})

test('runner rejects completed snapshots with unsafe or mismatched results', async () => {
  const fixture = createInMemoryExecutionAdapterConformanceFixture()
  const originalCreateAdapter = fixture.createAdapter
  const report = await runExecutionAdapterConformance({
    ...fixture,
    createAdapter(scenario) {
      const adapter = originalCreateAdapter(scenario)
      if (scenario !== 'complete') return adapter
      return {
        dispatch: adapter.dispatch.bind(adapter),
        cancel: adapter.cancel.bind(adapter),
        async inspect(reference, signal) {
          const outcome = await adapter.inspect(reference, signal)
          if (outcome.ok && outcome.value.state === 'completed' && outcome.value.result) {
            return {
              ok: true,
              value: {
                ...outcome.value,
                result: {
                  ...outcome.value.result,
                  taskId: 'different-task',
                  changedFiles: ['C:\\private\\secret.txt'],
                },
              },
            }
          }
          return outcome
        },
      }
    },
  })

  assert.equal(report.passed, false)
  assert.equal(report.checks.find(check => check.id === 'complete.result')?.passed, false)
  assert.doesNotMatch(JSON.stringify(report), /C:\\private|secret\.txt/i)
})
