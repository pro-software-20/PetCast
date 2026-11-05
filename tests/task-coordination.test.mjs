import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTs } from './load-ts.mjs'

const {
  validateAcceptanceDecision,
  validateAcceptancePolicy,
  validateEvaluationReport,
  validateExecutionDispatchRequest,
  validateExecutionReceipt,
  validateExecutionReference,
  validateExecutionSnapshot,
} = await loadTs('../src/orchestration/taskCoordinationValidation.ts')
const { decideTaskAcceptance } = await loadTs('../src/orchestration/taskAcceptancePolicy.ts')
const {
  InMemoryExecutionAdapter,
  createEvaluationReportFixture,
} = await loadTs('../src/orchestration/executionAdapterFixtures.ts')
const { WorkerProviderExecutionAdapter } = await loadTs('../src/orchestration/workerExecutionAdapter.ts')

const task = (overrides = {}) => ({
  id: 'task-2',
  title: '实现任务协调契约',
  description: '根据前置设计实现并验证协调契约。',
  dependsOn: ['task-1'],
  recommendedProviderId: 'codex',
  executionMode: 'local-agent',
  prompt: '实现任务协调契约，并运行零依赖测试。',
  files: {
    inputs: [{ kind: 'workspace', path: 'src/types/taskCoordination.ts' }],
    readPaths: ['src'],
    allowedWritePaths: ['src/orchestration'],
    forbiddenPaths: ['.env.local'],
    outputPaths: ['src/orchestration/taskCoordinationValidation.ts'],
  },
  expectedDeliverables: ['协调契约实现'],
  acceptanceChecks: ['契约测试通过'],
  ...overrides,
})

const dependency = (overrides = {}) => ({
  dependencyTaskId: 'task-1',
  summary: '已完成协调边界设计。',
  keyDecisions: ['B 只通过 A 的执行适配器派发任务。'],
  verification: [{ label: '设计已评审', status: 'passed' }],
  artifacts: [{ path: 'docs/B_P30_COORDINATION_CONTRACT.md', description: '协调边界说明。' }],
  openQuestions: [],
  ...overrides,
})

const dispatch = (overrides = {}) => ({
  dispatchId: 'dispatch-1',
  sessionId: 'session-1',
  planId: 'plan-1',
  taskId: 'task-2',
  attempt: 1,
  providerId: 'codex',
  task: task(),
  directDependencies: [dependency()],
  ...overrides,
})

const result = (overrides = {}) => ({
  taskId: 'task-2',
  providerId: 'codex',
  summary: '协调契约和测试已经完成。',
  changedFiles: ['src/types/taskCoordination.ts'],
  verification: [{ label: '契约测试通过', status: 'passed' }],
  ...overrides,
})

const reference = {
  dispatchId: 'dispatch-1',
  adapterExecutionId: 'adapter-1',
  taskId: 'task-2',
}

const adapterError = (overrides = {}) => ({
  code: 'FAILED',
  retryable: true,
  message: '执行器暂时不可用。',
  ...overrides,
})

const snapshot = (state, overrides = {}) => ({
  ...reference,
  state,
  observedAt: '2026-11-05T00:00:00.000Z',
  ...overrides,
})

const issueCodes = validation => {
  assert.equal(validation.ok, false)
  return validation.issues.map(issue => issue.code)
}

test('validates a dispatch with only direct dependency handoff data', () => {
  const value = dispatch()
  const before = structuredClone(value)
  const validated = validateExecutionDispatchRequest(value)
  assert.equal(validated.ok, true)
  assert.equal(validated.value, value)
  assert.deepEqual(value, before)
  assert.equal(JSON.stringify(value).includes('outputText'), false)
})

test('rejects credentials, unknown fields, unsafe paths and non-direct dependencies', () => {
  const credential = dispatch({ apiKey: 'secret' })
  assert.ok(issueCodes(validateExecutionDispatchRequest(credential)).includes('UNKNOWN_FIELD'))

  const absolute = dispatch({
    directDependencies: [dependency({
      artifacts: [{ path: 'C:\\secret.txt', description: 'unsafe' }],
    })],
  })
  assert.ok(issueCodes(validateExecutionDispatchRequest(absolute)).includes('INVALID_PATH'))

  const unrelated = dispatch({
    directDependencies: [dependency({ dependencyTaskId: 'task-99' })],
  })
  assert.ok(issueCodes(validateExecutionDispatchRequest(unrelated)).includes('TASK_MISMATCH'))

  const fullOutput = dispatch({
    directDependencies: [{ ...dependency(), outputText: '完整供应商输出' }],
  })
  assert.ok(issueCodes(validateExecutionDispatchRequest(fullOutput)).includes('UNKNOWN_FIELD'))
})

test('validates execution references and receipts with strict correlation', () => {
  assert.equal(validateExecutionReference(reference).ok, true)
  assert.equal(validateExecutionReceipt({
    ...reference,
    state: 'queued',
    acceptedAt: '2026-11-05T00:00:00.000Z',
  }, { taskId: 'task-2', dispatchId: 'dispatch-1' }).ok, true)
  assert.ok(issueCodes(validateExecutionReceipt({
    ...reference,
    state: 'queued',
    acceptedAt: '2026-11-05T00:00:00.000Z',
  }, { taskId: 'other' })).includes('TASK_MISMATCH'))
})

test('enforces snapshot state and result invariants', () => {
  for (const state of ['queued', 'running', 'cancelled']) {
    assert.equal(validateExecutionSnapshot(snapshot(state)).ok, true, state)
  }
  assert.equal(validateExecutionSnapshot(snapshot('needs-input', {
    error: adapterError({ code: 'NEEDS_INPUT', retryable: false }),
  })).ok, true)
  assert.equal(validateExecutionSnapshot(snapshot('completed', { result: result() }), {
    taskId: 'task-2',
    dispatchId: 'dispatch-1',
    providerId: 'codex',
  }).ok, true)
  assert.equal(validateExecutionSnapshot(snapshot('failed', { error: adapterError() })).ok, true)
  assert.equal(validateExecutionSnapshot(snapshot('unknown', {
    error: adapterError({ code: 'EXECUTION_NOT_FOUND', retryable: false }),
  })).ok, true)

  assert.ok(issueCodes(validateExecutionSnapshot(snapshot('completed'))).includes('INVALID_STATE'))
  assert.ok(issueCodes(validateExecutionSnapshot(snapshot('running', { result: result() }))).includes('INVALID_STATE'))
  assert.ok(issueCodes(validateExecutionSnapshot(snapshot('failed'))).includes('INVALID_STATE'))
  assert.ok(issueCodes(validateExecutionSnapshot(snapshot('completed', {
    result: result({ taskId: 'other' }),
  }), { taskId: 'task-2' })).includes('TASK_MISMATCH'))
})

test('validates safe adapter errors for timeout, rate limits, cancellation and unavailable states', () => {
  const cases = [
    adapterError({ code: 'TIMEOUT' }),
    adapterError({ code: 'RATE_LIMITED', retryAfterSeconds: 30 }),
    adapterError({ code: 'CANCELLED', retryable: false }),
    adapterError({ code: 'UNAVAILABLE' }),
  ]
  for (const error of cases) {
    assert.equal(validateExecutionSnapshot(snapshot('failed', { error })).ok, true)
  }
  assert.ok(issueCodes(validateExecutionSnapshot(snapshot('failed', {
    error: { ...adapterError(), providerResponse: 'sensitive raw body' },
  }))).includes('UNKNOWN_FIELD'))
})

test('in-memory adapter is idempotent and inspect never redispatches work', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  let handlerCalls = 0
  const adapter = new InMemoryExecutionAdapter(async () => {
    handlerCalls += 1
    await gate
    return { ok: true, value: result() }
  })

  const first = await adapter.dispatch(dispatch())
  const duplicate = await adapter.dispatch(dispatch())
  assert.equal(first.ok, true)
  assert.equal(duplicate.ok, true)
  assert.deepEqual(duplicate.value, first.value)
  assert.equal(adapter.dispatchCallCount, 1)
  assert.equal(handlerCalls, 1)

  const running = await adapter.inspect({
    dispatchId: first.value.dispatchId,
    adapterExecutionId: first.value.adapterExecutionId,
    taskId: first.value.taskId,
  })
  assert.equal(running.ok, true)
  assert.equal(running.value.state, 'running')
  assert.equal(adapter.dispatchCallCount, 1)

  release()
  await new Promise(resolve => setImmediate(resolve))
  const completed = await adapter.inspect({
    dispatchId: first.value.dispatchId,
    adapterExecutionId: first.value.adapterExecutionId,
    taskId: first.value.taskId,
  })
  assert.equal(completed.ok, true)
  assert.equal(completed.value.state, 'completed')
  assert.equal(adapter.dispatchCallCount, 1)

  const conflicting = await adapter.dispatch(dispatch({ attempt: 2 }))
  assert.equal(conflicting.ok, false)
  assert.equal(conflicting.error.code, 'INVALID_INPUT')
})

test('in-memory adapter supports cancellation and unknown execution without provider calls', async () => {
  const adapter = new InMemoryExecutionAdapter(async (_request, signal) => {
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
    return { ok: false, error: adapterError({ code: 'CANCELLED', retryable: false }) }
  })
  const receipt = await adapter.dispatch(dispatch())
  assert.equal(receipt.ok, true)
  const ref = {
    dispatchId: receipt.value.dispatchId,
    adapterExecutionId: receipt.value.adapterExecutionId,
    taskId: receipt.value.taskId,
  }
  const cancelled = await adapter.cancel(ref)
  assert.equal(cancelled.ok, true)
  assert.equal(cancelled.value.state, 'cancelled')
  const missing = await adapter.inspect({ ...ref, dispatchId: 'dispatch-missing' })
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'EXECUTION_NOT_FOUND')
})

test('legacy WorkerProvider adapter calls the one-shot worker only once', async () => {
  let calls = 0
  const worker = {
    profile: {
      id: 'codex',
      displayName: 'Codex fixture',
      capabilities: ['coding'],
      executionModes: ['local-agent'],
      quotaSupport: 'none',
    },
    async execute(request) {
      calls += 1
      assert.equal(request.dependencyResults[0].outputText, undefined)
      return { ok: true, result: result() }
    },
  }
  const adapter = new WorkerProviderExecutionAdapter(worker)
  const first = await adapter.dispatch(dispatch())
  const second = await adapter.dispatch(dispatch())
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls, 1)
})

test('strictly validates accepted, revise and unknown evaluation reports', () => {
  for (const verdict of ['accepted', 'revise', 'unknown']) {
    const report = createEvaluationReportFixture({ verdict })
    const before = structuredClone(report)
    assert.equal(validateEvaluationReport(report, {
      taskId: report.taskId,
      dispatchId: report.dispatchId,
    }).ok, true)
    assert.deepEqual(report, before)
  }

  assert.ok(issueCodes(validateEvaluationReport(createEvaluationReportFixture({
    evidence: [{ type: 'artifact', reference: 'C:\\private\\result.txt', summary: 'unsafe' }],
  }))).includes('INVALID_PATH'))
  assert.ok(issueCodes(validateEvaluationReport({
    ...createEvaluationReportFixture(),
    rawProviderResponse: 'must not cross the boundary',
  })).includes('UNKNOWN_FIELD'))
})

test('manual acceptance policy never automatically completes a task', () => {
  const policy = { mode: 'manual', trustedMethods: [], maxAttempts: 3 }
  assert.equal(validateAcceptancePolicy(policy).ok, true)
  for (const verdict of ['accepted', 'revise', 'unknown']) {
    const decision = decideTaskAcceptance({
      report: createEvaluationReportFixture({ verdict }),
      policy,
      attempt: 1,
    })
    assert.equal(decision.action, 'manual-review')
    assert.equal(decision.requiresHumanConfirmation, true)
    assert.equal(validateAcceptanceDecision(decision).ok, true)
  }
})

test('trusted policy completes only accepted reports with every check passed', () => {
  const policy = { mode: 'trusted-evaluation', trustedMethods: ['rubric'], maxAttempts: 2 }
  assert.equal(validateAcceptancePolicy(policy).ok, true)

  const completed = decideTaskAcceptance({
    report: createEvaluationReportFixture(),
    policy,
    attempt: 1,
  })
  assert.equal(completed.action, 'complete')
  assert.equal(completed.requiresHumanConfirmation, false)

  const incomplete = decideTaskAcceptance({
    report: createEvaluationReportFixture({
      verification: [{ label: '输出满足任务要求', status: 'not-run' }],
    }),
    policy,
    attempt: 1,
  })
  assert.equal(incomplete.action, 'manual-review')

  const revise = decideTaskAcceptance({
    report: createEvaluationReportFixture({ verdict: 'revise' }),
    policy,
    attempt: 1,
  })
  assert.equal(revise.action, 'request-changes')

  const exhausted = decideTaskAcceptance({
    report: createEvaluationReportFixture({ verdict: 'revise' }),
    policy,
    attempt: 2,
  })
  assert.equal(exhausted.action, 'manual-review')

  const untrusted = decideTaskAcceptance({
    report: createEvaluationReportFixture({ method: 'automated' }),
    policy,
    attempt: 1,
  })
  assert.equal(untrusted.action, 'manual-review')
})

test('acceptance policy and decisions reject malformed and cross-task data without mutation', () => {
  const invalidPolicy = { mode: 'trusted-evaluation', trustedMethods: ['rubric', 'rubric'], maxAttempts: 0 }
  const before = structuredClone(invalidPolicy)
  assert.equal(validateAcceptancePolicy(invalidPolicy).ok, false)
  assert.deepEqual(invalidPolicy, before)

  const decision = decideTaskAcceptance({
    report: createEvaluationReportFixture(),
    policy: { mode: 'manual', trustedMethods: [], maxAttempts: 3 },
    attempt: 1,
  })
  assert.ok(issueCodes(validateAcceptanceDecision(decision, {
    taskId: 'different-task',
  })).includes('TASK_MISMATCH'))
})
