import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTs } from './load-ts.mjs'

const { createTaskSession } = await loadTs('../src/orchestration/taskSession.ts')
const { reconcileTaskSessionWithCoordination } = await loadTs('../src/orchestration/taskCoordinationSession.ts')
const { reconcileTaskEvaluation } = await loadTs('../src/orchestration/taskEvaluationReconciliation.ts')
const { createTaskEvaluationRequest } = await loadTs('../src/orchestration/taskEvaluationRequest.ts')
const {
  LocalTaskAcceptanceStore,
  MemoryTaskAcceptanceStore,
  TASK_ACCEPTANCE_STORAGE_KEY,
} = await loadTs('../src/orchestration/TaskAcceptanceStore.ts')
const { validateTaskAcceptanceState } = await loadTs('../src/orchestration/taskEvaluationValidation.ts')

const NOW = '2026-11-07T08:00:00.000Z'
const COMPLETE = '2026-11-07T08:01:00.000Z'
const EVALUATED = '2026-11-07T08:02:00.000Z'

const analysisResult = {
  taskType: 'analysis',
  complexity: 'medium',
  estimatedInputTokens: { min: 10, max: 20 },
  estimatedOutputTokens: { min: 100, max: 200 },
  estimationBasis: 'heuristic-metadata',
  assumptions: ['metadata only'],
  optimizedPrompt: 'Evaluate the result.',
  promptOptimizationSource: 'local',
  canRunInParallel: false,
  parallelPlan: ['Run serially.'],
  warnings: [],
}

const task = (id = 'task-1') => ({
  id,
  title: `Task ${id}`,
  description: `Complete ${id}`,
  dependsOn: [],
  recommendedProviderId: 'deepseek',
  executionMode: 'api',
  prompt: `Complete ${id}`,
  files: { inputs: [], readPaths: [], allowedWritePaths: [], forbiddenPaths: [], outputPaths: [] },
  expectedDeliverables: [`${id} result`],
  acceptanceChecks: [`${id} is correct`],
})

const createReviewFixture = (attempt = 1) => {
  const created = createTaskSession({
    analysisInput: { prompt: 'Evaluate the task.', files: [] },
    analysisResult,
    plan: {
      schemaVersion: 1,
      id: 'plan-evaluation',
      title: 'Evaluation plan',
      goal: 'Evaluate execution results.',
      assumptions: ['D returns a safe report.'],
      tasks: [task()],
      finalAcceptanceChecks: ['All results reviewed.'],
    },
  }, NOW)
  assert.equal(created.ok, true, created.message)
  const session = created.session
  const dispatchId = 'dispatch-task-1-1'
  const reference = { dispatchId, adapterExecutionId: 'adapter-1', taskId: 'task-1' }
  const result = {
    taskId: 'task-1',
    providerId: 'deepseek',
    summary: 'Execution completed safely.',
    outputText: 'A longer output that must never be copied into the evaluation request.',
    changedFiles: ['docs/result.md'],
    verification: [{ label: 'task-1 is correct', status: 'not-run' }],
  }
  const coordinationState = {
    schemaVersion: 1,
    sessionId: session.id,
    planId: session.plan.id,
    updatedAt: COMPLETE,
    records: [{
      taskId: 'task-1',
      providerId: 'deepseek',
      attempt: 1,
      dispatchId,
      phase: 'completed',
      reference,
      latestSnapshot: { ...reference, state: 'completed', observedAt: COMPLETE, result },
      createdAt: NOW,
      updatedAt: COMPLETE,
    }],
  }
  const reconciled = reconcileTaskSessionWithCoordination({ session, coordinationState })
  assert.equal(reconciled.ok, true, reconciled.message)
  assert.equal(reconciled.session.runs[0].status, 'review')
  if (attempt === 1) return { session: reconciled.session, coordinationState, dispatchId }

  const adjustedSession = structuredClone(reconciled.session)
  adjustedSession.runs[0].attempt = attempt
  const adjustedState = structuredClone(coordinationState)
  const adjustedDispatchId = `dispatch-task-1-${attempt}`
  adjustedState.records[0].attempt = attempt
  adjustedState.records[0].dispatchId = adjustedDispatchId
  adjustedState.records[0].reference.dispatchId = adjustedDispatchId
  adjustedState.records[0].reference.adapterExecutionId = `adapter-${attempt}`
  adjustedState.records[0].latestSnapshot.dispatchId = adjustedDispatchId
  adjustedState.records[0].latestSnapshot.adapterExecutionId = `adapter-${attempt}`
  return { session: adjustedSession, coordinationState: adjustedState, dispatchId: adjustedDispatchId }
}

const reportFor = (dispatchId, overrides = {}) => ({
  evaluationId: 'evaluation-1',
  dispatchId,
  taskId: 'task-1',
  verdict: 'accepted',
  verification: [{ label: 'task-1 is correct', status: 'passed' }],
  method: 'rubric',
  ruleVersion: 'rubric-v1',
  comparisonBasis: 'Compared the safe result summary with the acceptance check.',
  evidence: [{ type: 'test-log', reference: 'ledger:test-1', summary: 'Checks passed.' }],
  note: '',
  createdAt: EVALUATED,
  ...overrides,
})

const manualPolicy = { mode: 'manual', trustedMethods: ['rubric'], maxAttempts: 2 }
const trustedPolicy = { mode: 'trusted-evaluation', trustedMethods: ['rubric'], maxAttempts: 2 }

test('manual policy records a safe decision without completing the task', () => {
  const fixture = createReviewFixture()
  const original = structuredClone(fixture.session)
  const outcome = reconcileTaskEvaluation({
    ...fixture,
    report: reportFor(fixture.dispatchId),
    policy: manualPolicy,
  })
  assert.equal(outcome.ok, true, outcome.message)
  assert.equal(outcome.changed, true)
  assert.equal(outcome.decision.action, 'manual-review')
  assert.equal(outcome.state.records[0].status, 'decided')
  assert.equal(fixture.session.runs[0].status, 'review')
  assert.deepEqual(fixture.session, original)
})

test('request builder sends only safe summaries and never the complete AI output', () => {
  const fixture = createReviewFixture()
  const built = createTaskEvaluationRequest({
    ...fixture,
    taskId: 'task-1',
    evaluationId: 'evaluation-safe-request',
    evidence: [{ type: 'artifact', reference: 'artifact:result-1', summary: 'Safe artifact reference.' }],
  })
  assert.equal(built.ok, true, built.message)
  assert.equal(built.request.result.summary, 'Execution completed safely.')
  assert.equal('outputText' in built.request.result, false)
  assert.doesNotMatch(JSON.stringify(built.request), /longer output that must never/i)
  assert.deepEqual(built.request.result.changedFiles, ['docs/result.md'])
})

test('trusted accepted report only suggests complete when every check passes', () => {
  const fixture = createReviewFixture()
  const accepted = reconcileTaskEvaluation({
    ...fixture,
    report: reportFor(fixture.dispatchId),
    policy: trustedPolicy,
  })
  assert.equal(accepted.ok, true, accepted.message)
  assert.equal(accepted.decision.action, 'complete')
  assert.equal(accepted.decision.requiresHumanConfirmation, false)

  const incomplete = reconcileTaskEvaluation({
    ...fixture,
    report: reportFor(fixture.dispatchId, {
      evaluationId: 'evaluation-incomplete',
      verification: [{ label: 'task-1 is correct', status: 'not-run' }],
    }),
    policy: trustedPolicy,
  })
  assert.equal(incomplete.ok, true, incomplete.message)
  assert.equal(incomplete.decision.action, 'manual-review')
})

test('revise and unknown decisions respect attempt limits', () => {
  const first = createReviewFixture(1)
  const revise = reconcileTaskEvaluation({
    ...first,
    report: reportFor(first.dispatchId, {
      evaluationId: 'evaluation-revise', verdict: 'revise',
      verification: [{ label: 'task-1 is correct', status: 'failed' }],
    }),
    policy: trustedPolicy,
  })
  assert.equal(revise.ok, true, revise.message)
  assert.equal(revise.decision.action, 'request-changes')

  const exhausted = createReviewFixture(2)
  const maxed = reconcileTaskEvaluation({
    ...exhausted,
    report: reportFor(exhausted.dispatchId, {
      evaluationId: 'evaluation-maxed', verdict: 'revise',
      verification: [{ label: 'task-1 is correct', status: 'failed' }],
    }),
    policy: trustedPolicy,
  })
  assert.equal(maxed.ok, true, maxed.message)
  assert.equal(maxed.decision.action, 'manual-review')

  const unknown = reconcileTaskEvaluation({
    ...first,
    report: reportFor(first.dispatchId, {
      evaluationId: 'evaluation-unknown', verdict: 'unknown',
      verification: [{ label: 'task-1 is correct', status: 'not-run' }],
    }),
    policy: trustedPolicy,
  })
  assert.equal(unknown.ok, true, unknown.message)
  assert.equal(unknown.decision.action, 'manual-review')
})

test('duplicate report is idempotent while conflicting and stale reports are rejected', () => {
  const fixture = createReviewFixture()
  const report = reportFor(fixture.dispatchId)
  const first = reconcileTaskEvaluation({ ...fixture, report, policy: manualPolicy })
  assert.equal(first.ok, true, first.message)
  const duplicate = reconcileTaskEvaluation({
    ...fixture,
    acceptanceState: first.state,
    report,
    policy: manualPolicy,
  })
  assert.equal(duplicate.ok, true, duplicate.message)
  assert.equal(duplicate.changed, false)
  assert.equal(duplicate.state.records.length, 1)

  const conflict = reconcileTaskEvaluation({
    ...fixture,
    acceptanceState: first.state,
    report: { ...report, note: 'different content' },
    policy: manualPolicy,
  })
  assert.equal(conflict.ok, false)
  assert.equal(conflict.code, 'REPORT_CONFLICT')

  const stale = reconcileTaskEvaluation({
    ...fixture,
    report: reportFor('dispatch-old', { evaluationId: 'evaluation-stale' }),
    policy: manualPolicy,
  })
  assert.equal(stale.ok, false)
  assert.equal(stale.code, 'STATE_MISMATCH')
})

test('mismatched checks, unsafe evidence and non-review sessions are rejected', () => {
  const fixture = createReviewFixture()
  const mismatched = reconcileTaskEvaluation({
    ...fixture,
    report: reportFor(fixture.dispatchId, {
      evaluationId: 'evaluation-label',
      verification: [{ label: 'different check', status: 'passed' }],
    }),
    policy: manualPolicy,
  })
  assert.equal(mismatched.ok, false)
  assert.equal(mismatched.code, 'INVALID_REPORT')

  const unsafe = reconcileTaskEvaluation({
    ...fixture,
    report: reportFor(fixture.dispatchId, {
      evaluationId: 'evaluation-unsafe',
      evidence: [{ type: 'artifact', reference: 'C:\\private\\result.txt', summary: 'unsafe' }],
    }),
    policy: manualPolicy,
  })
  assert.equal(unsafe.ok, false)
  assert.equal(unsafe.code, 'INVALID_REPORT')

  const notReview = structuredClone(fixture.session)
  notReview.runs[0].status = 'running'
  delete notReview.runs[0].result
  const wrongState = reconcileTaskEvaluation({
    ...fixture,
    session: notReview,
    report: reportFor(fixture.dispatchId),
    policy: manualPolicy,
  })
  assert.equal(wrongState.ok, false)
})

test('old providers and cross-task reports cannot replace the current evaluation', () => {
  const fixture = createReviewFixture()
  const oldProviderState = structuredClone(fixture.coordinationState)
  oldProviderState.records[0].providerId = 'codex'
  oldProviderState.records[0].latestSnapshot.result.providerId = 'codex'
  const oldProvider = reconcileTaskEvaluation({
    ...fixture,
    coordinationState: oldProviderState,
    report: reportFor(fixture.dispatchId, { evaluationId: 'evaluation-old-provider' }),
    policy: manualPolicy,
  })
  assert.equal(oldProvider.ok, false)
  assert.equal(oldProvider.code, 'STATE_MISMATCH')

  const crossTask = reconcileTaskEvaluation({
    ...fixture,
    report: reportFor(fixture.dispatchId, {
      evaluationId: 'evaluation-cross-task',
      taskId: 'task-other',
    }),
    policy: manualPolicy,
  })
  assert.equal(crossTask.ok, false)
  assert.equal(crossTask.code, 'STATE_MISMATCH')
})

test('acceptance stores save, restore and preserve corrupt data', async () => {
  const fixture = createReviewFixture()
  const outcome = reconcileTaskEvaluation({
    ...fixture,
    report: reportFor(fixture.dispatchId),
    policy: manualPolicy,
  })
  assert.equal(outcome.ok, true, outcome.message)
  assert.equal(validateTaskAcceptanceState(outcome.state).ok, true)

  const memory = new MemoryTaskAcceptanceStore()
  assert.deepEqual(await memory.save(outcome.state), { ok: true })
  const loaded = await memory.load({
    sessionId: fixture.session.id,
    planId: fixture.session.plan.id,
    taskIds: ['task-1'],
  })
  assert.equal(loaded.ok, true)
  assert.deepEqual(loaded.state, outcome.state)
  loaded.state.records[0].report.note = 'mutated clone'
  assert.notEqual(memory.peek().records[0].report.note, 'mutated clone')

  const data = new Map([[TASK_ACCEPTANCE_STORAGE_KEY, '{broken']])
  const storage = {
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: key => data.delete(key),
  }
  const local = new LocalTaskAcceptanceStore(storage)
  const corrupt = await local.load({ sessionId: fixture.session.id, planId: fixture.session.plan.id })
  assert.equal(corrupt.ok, false)
  assert.equal(corrupt.code, 'CORRUPT_DATA')
  assert.equal(data.get(TASK_ACCEPTANCE_STORAGE_KEY), '{broken')
})

test('D evaluates failed and corrected attempts through the B decision bridge', async () => {
  const { TaskEvidenceAdapter } = await loadTs('../src/reports/taskEvidenceAdapter.ts')
  const evaluator = new TaskEvidenceAdapter()
  let prior = null
  for (const [attempt, status, verdict] of [[1,'failed','revise'],[2,'passed','accepted']]) {
    const f = createReviewFixture(attempt)
    const check = f.session.runs[0].result.verification[0]
    check.status = status
    check.details = 'Checked against the requested deliverable.'
    const built = createTaskEvaluationRequest({...f,taskId:'task-1',evaluationId:'d-review-'+attempt,
      evidence:[{type:'user-review',reference:'check:0',summary:'Reviewed task result.'}]})
    assert.ok(built.ok, built.message)
    const report = await evaluator.evaluate(built.request,new AbortController().signal)
    assert.equal(report.verdict,verdict)
    const next = reconcileTaskEvaluation({...f,acceptanceState:prior,report,policy:{mode:'manual',trustedMethods:[],maxAttempts:3}})
    assert.ok(next.ok,next.message)
    assert.equal(next.decision.action,'manual-review')
    prior = next.state
  }
  assert.equal(prior.records.length,2)
})
