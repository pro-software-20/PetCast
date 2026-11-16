import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTs } from './load-ts.mjs'

const { runTaskEvaluationAdapterConformance } = await loadTs('../src/orchestration/evaluationAdapterConformance.ts')
const {
  createInMemoryTaskEvaluationAdapterConformanceFixture,
  createTaskEvaluationRequestFixture,
} = await loadTs('../src/orchestration/taskEvaluationFixtures.ts')
const { validateTaskEvaluationRequest } = await loadTs('../src/orchestration/taskEvaluationValidation.ts')

test('zero-network D evaluator passes the complete conformance suite', async () => {
  const report = await runTaskEvaluationAdapterConformance(
    createInMemoryTaskEvaluationAdapterConformanceFixture(),
  )
  assert.equal(report.passed, true, JSON.stringify(report.checks.filter(check => !check.passed), null, 2))
  assert.ok(report.checks.some(check => check.id === 'report.accepted'))
  assert.ok(report.checks.some(check => check.id === 'report.idempotent'))
  assert.ok(report.checks.some(check => check.id === 'report.invalid-response'))
  assert.doesNotMatch(JSON.stringify(report), /api[_ -]?key|authorization|[A-Za-z]:[\\/]/i)
})

test('evaluation request rejects full output, unsafe paths and unknown fields', () => {
  const request = createTaskEvaluationRequestFixture()
  const withOutput = {
    ...request,
    result: { ...request.result, outputText: 'complete provider output must not be sent' },
  }
  assert.equal(validateTaskEvaluationRequest(withOutput).ok, false)

  const unsafe = {
    ...request,
    result: { ...request.result, changedFiles: ['C:\\Users\\private.txt'] },
  }
  assert.equal(validateTaskEvaluationRequest(unsafe).ok, false)

  const sensitive = { ...request, apiKey: 'secret' }
  assert.equal(validateTaskEvaluationRequest(sensitive).ok, false)
})
