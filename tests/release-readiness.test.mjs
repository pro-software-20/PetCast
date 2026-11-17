import assert from 'node:assert/strict'
import test from 'node:test'
import { RELEASE_READINESS_STEPS } from '../scripts/verify-release-readiness.mjs'

test('release readiness gate contains the complete local coordination checks only', () => {
  const ids = RELEASE_READINESS_STEPS.map(step => step.id)
  assert.deepEqual(ids, [
    'contracts',
    'typecheck',
    'adapter-conformance',
    'evaluation-conformance',
    'coordination-e2e',
    'coordination-d-e2e',
    'desktop-deepseek-d-e2e',
    'build',
    'task-ui',
    'task-recovery-ui',
    'desktop-smoke',
    'diff-check',
  ])
  const rendered = JSON.stringify(RELEASE_READINESS_STEPS).toLowerCase()
  assert.doesNotMatch(rendered, /dev:ai|test:task-planning:live|test:public-ai|deepseek_api_key/)
  assert.ok(RELEASE_READINESS_STEPS.every(step => step.command && step.args.length > 0))
})
