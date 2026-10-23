import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTs } from './load-ts.mjs'

const {
  createTaskSession,
  updateTaskSession,
} = await loadTs('../src/orchestration/taskSession.ts')
const {
  MAX_TASK_RESULT_LENGTH,
  validateTaskSession,
} = await loadTs('../src/orchestration/taskSessionValidation.ts')
const {
  LocalTaskSessionStore,
  TASK_SESSION_STORAGE_KEY,
} = await loadTs('../src/orchestration/TaskSessionStore.ts')
const { generateTaskSessionReport } = await loadTs('../src/orchestration/taskReport.ts')
const { buildManualTaskPrompt } = await loadTs('../src/orchestration/manualTaskPrompt.ts')

const NOW = '2026-10-22T08:00:00.000Z'
const LATER = '2026-10-22T08:05:00.000Z'
const DONE = '2026-10-22T08:10:00.000Z'

const plan = () => ({
  schemaVersion: 1,
  id: 'plan-p2',
  title: 'P2 测试计划',
  goal: '完成两个有依赖关系的任务。',
  assumptions: ['人工复制并验收。'],
  tasks: [
    {
      id: 'task-1',
      title: '分析需求',
      description: '先完成需求分析。',
      dependsOn: [],
      recommendedProviderId: 'deepseek',
      executionMode: 'manual',
      prompt: '分析需求并给出方案。',
      files: { inputs: [], allowedWritePaths: [], forbiddenPaths: [], outputPaths: [] },
      expectedDeliverables: ['需求方案'],
      acceptanceChecks: ['方案覆盖目标'],
    },
    {
      id: 'task-2',
      title: '实现功能',
      description: '根据方案实现功能。',
      dependsOn: ['task-1'],
      recommendedProviderId: 'codex',
      executionMode: 'manual',
      prompt: '实现已确认方案。',
      files: { inputs: [], allowedWritePaths: [], forbiddenPaths: [], outputPaths: [] },
      expectedDeliverables: ['实现结果'],
      acceptanceChecks: ['实现通过检查'],
    },
  ],
  finalAcceptanceChecks: ['全部任务结果一致', '没有遗漏待确认问题'],
})

const branchedPlan = () => {
  const source = plan()
  const implementation = source.tasks[1]
  return {
    ...source,
    id: 'plan-p2-branch',
    title: 'P2.1 并行分支计划',
    tasks: [
      source.tasks[0],
      implementation,
      {
        ...implementation,
        id: 'task-3',
        title: '撰写说明',
        description: '独立撰写使用说明。',
        dependsOn: [],
        prompt: '撰写使用说明。',
        acceptanceChecks: ['说明覆盖使用方式'],
      },
      {
        ...implementation,
        id: 'task-4',
        title: '汇总结果',
        description: '等待实现和说明完成后汇总。',
        dependsOn: ['task-2', 'task-3'],
        prompt: '汇总实现和说明。',
        acceptanceChecks: ['汇总结果一致'],
      },
    ],
  }
}

const input = () => ({
  analysisInput: { prompt: '先分析需求，再实现功能', files: [] },
  analysisResult: {
    taskType: 'coding',
    complexity: 'medium',
    estimatedInputTokens: { min: 10, max: 20 },
    estimatedOutputTokens: { min: 500, max: 1500 },
    estimationBasis: 'heuristic-metadata',
    assumptions: ['仅使用元信息。'],
    optimizedPrompt: '先分析需求，再实现功能。',
    promptOptimizationSource: 'local',
    canRunInParallel: false,
    parallelPlan: ['串行执行。'],
    warnings: [],
  },
  plan: plan(),
})

const mustCreate = () => {
  const outcome = createTaskSession(input(), NOW)
  assert.equal(outcome.ok, true)
  return outcome.session
}

const mustUpdate = (session, action, now = LATER) => {
  const outcome = updateTaskSession(session, action, now)
  assert.equal(outcome.ok, true, outcome.message)
  return outcome.session
}

const completeFirstTask = (session) => {
  let next = mustUpdate(session, { type: 'start', taskId: 'task-1' })
  next = mustUpdate(next, {
    type: 'update-draft',
    taskId: 'task-1',
    draft: {
      outputText: '方案摘要\n\nFULL_PRIVATE_RESULT',
      changedFiles: ['docs/plan.md'],
      verification: [{ label: '方案覆盖目标', status: 'passed' }],
      reviewNote: '人工确认方案可执行。',
    },
  })
  next = mustUpdate(next, { type: 'submit-result', taskId: 'task-1' })
  return mustUpdate(next, { type: 'accept', taskId: 'task-1' }, DONE)
}

const completeTask = (session, taskId) => {
  const task = session.plan.tasks.find(candidate => candidate.id === taskId)
  assert.ok(task)
  let next = mustUpdate(session, { type: 'start', taskId })
  next = mustUpdate(next, {
    type: 'update-draft',
    taskId,
    draft: {
      outputText: `${task.title}结果摘要`,
      verification: task.acceptanceChecks.map(label => ({ label, status: 'passed' })),
    },
  })
  next = mustUpdate(next, { type: 'submit-result', taskId })
  return mustUpdate(next, { type: 'accept', taskId }, DONE)
}

test('creates ready roots and waiting dependency tasks without mutating input', () => {
  const source = input()
  const before = structuredClone(source)
  const outcome = createTaskSession(source, NOW)

  assert.equal(outcome.ok, true)
  assert.deepEqual(source, before)
  assert.deepEqual(outcome.session.runs.map(run => run.status), ['ready', 'waiting'])
  assert.deepEqual(outcome.session.runs.map(run => run.attempt), [0, 0])
  assert.equal(validateTaskSession(outcome.session).ok, true)
})

test('allows dependency edits only before execution and recalculates readiness', () => {
  const original = mustCreate()
  const before = structuredClone(original)
  let session = mustUpdate(original, {
    type: 'set-task-dependencies',
    taskId: 'task-2',
    dependsOn: [],
  })

  assert.deepEqual(original, before)
  assert.deepEqual(session.plan.tasks[1].dependsOn, [])
  assert.deepEqual(session.runs.map(run => run.status), ['ready', 'ready'])

  session = mustUpdate(session, {
    type: 'set-task-dependencies',
    taskId: 'task-2',
    dependsOn: ['task-1'],
  })
  assert.deepEqual(session.runs.map(run => run.status), ['ready', 'waiting'])

  for (const dependsOn of [
    ['task-1', 'task-1'],
    ['missing'],
    ['task-2'],
  ]) {
    const invalid = updateTaskSession(session, {
      type: 'set-task-dependencies',
      taskId: 'task-2',
      dependsOn,
    }, LATER)
    assert.equal(invalid.ok, false)
    assert.equal(invalid.code, 'INVALID_DATA')
  }

  const laterDependency = updateTaskSession(session, {
    type: 'set-task-dependencies',
    taskId: 'task-1',
    dependsOn: ['task-2'],
  }, LATER)
  assert.equal(laterDependency.ok, false)

  const started = mustUpdate(session, { type: 'start', taskId: 'task-1' })
  const locked = updateTaskSession(started, {
    type: 'set-task-dependencies',
    taskId: 'task-2',
    dependsOn: [],
  }, DONE)
  assert.equal(locked.ok, false)
  assert.equal(locked.code, 'INVALID_TRANSITION')
})

test('keeps independent branches available and unlocks joins only after every dependency completes', () => {
  const created = createTaskSession({ ...input(), plan: branchedPlan() }, NOW)
  assert.equal(created.ok, true)
  let session = created.session
  assert.deepEqual(session.runs.map(run => run.status), ['ready', 'waiting', 'ready', 'waiting'])

  session = completeTask(session, 'task-1')
  assert.deepEqual(session.runs.map(run => run.status), ['done', 'ready', 'ready', 'waiting'])

  session = completeTask(session, 'task-2')
  assert.deepEqual(session.runs.map(run => run.status), ['done', 'done', 'ready', 'waiting'])

  session = completeTask(session, 'task-3')
  assert.deepEqual(session.runs.map(run => run.status), ['done', 'done', 'done', 'ready'])
})

test('blocks invalid starts and provider changes after a task starts', () => {
  const session = mustCreate()
  const blocked = updateTaskSession(session, { type: 'start', taskId: 'task-2' }, LATER)
  assert.equal(blocked.ok, false)
  assert.equal(blocked.code, 'INVALID_TRANSITION')

  const assigned = mustUpdate(session, { type: 'assign-provider', taskId: 'task-1', providerId: 'codex' })
  assert.equal(assigned.runs[0].assignedProviderId, 'codex')
  const started = mustUpdate(assigned, { type: 'start', taskId: 'task-1' })
  assert.equal(started.runs[0].status, 'running')
  assert.equal(started.runs[0].attempt, 1)
  assert.equal(updateTaskSession(started, { type: 'assign-provider', taskId: 'task-1', providerId: 'doubao' }, DONE).ok, false)
})

test('requires pasted output and passed checks before unlocking dependencies', () => {
  let session = mustUpdate(mustCreate(), { type: 'start', taskId: 'task-1' })
  assert.equal(updateTaskSession(session, { type: 'submit-result', taskId: 'task-1' }, DONE).ok, false)

  session = mustUpdate(session, {
    type: 'update-draft',
    taskId: 'task-1',
    draft: { outputText: '完成了分析。' },
  })
  session = mustUpdate(session, { type: 'submit-result', taskId: 'task-1' })
  assert.equal(session.runs[0].status, 'review')
  assert.equal(updateTaskSession(session, { type: 'accept', taskId: 'task-1' }, DONE).ok, false)
  assert.equal(session.runs[1].status, 'waiting')

  session = mustUpdate(session, { type: 'request-changes', taskId: 'task-1', message: '补充验证。' })
  session = mustUpdate(session, {
    type: 'update-draft',
    taskId: 'task-1',
    draft: { verification: [{ label: '方案覆盖目标', status: 'passed' }] },
  })
  session = mustUpdate(session, { type: 'submit-result', taskId: 'task-1' })
  session = mustUpdate(session, { type: 'accept', taskId: 'task-1' }, DONE)
  assert.deepEqual(session.runs.map(run => run.status), ['done', 'ready'])
})

test('supports needs-input, failure, cancellation and retry transitions', () => {
  let session = mustUpdate(mustCreate(), { type: 'start', taskId: 'task-1' })
  session = mustUpdate(session, { type: 'needs-input', taskId: 'task-1', message: '缺少目标平台。' })
  assert.equal(session.runs[0].status, 'needs-input')
  session = mustUpdate(session, { type: 'resume', taskId: 'task-1' })
  session = mustUpdate(session, { type: 'fail', taskId: 'task-1', message: '外部 AI 无响应。' })
  assert.equal(session.runs[0].status, 'failed')
  session = mustUpdate(session, { type: 'retry', taskId: 'task-1' })
  assert.equal(session.runs[0].status, 'ready')
  session = mustUpdate(session, { type: 'cancel', taskId: 'task-1' })
  assert.equal(session.runs[0].status, 'cancelled')
})

test('rejects unsafe drafts, oversized results and inconsistent stored sessions', () => {
  const running = mustUpdate(mustCreate(), { type: 'start', taskId: 'task-1' })
  const unsafe = updateTaskSession(running, {
    type: 'update-draft',
    taskId: 'task-1',
    draft: { changedFiles: ['../outside.txt'] },
  }, DONE)
  assert.equal(unsafe.ok, false)
  assert.equal(unsafe.code, 'INVALID_DATA')

  const oversized = updateTaskSession(running, {
    type: 'update-draft',
    taskId: 'task-1',
    draft: { outputText: 'x'.repeat(MAX_TASK_RESULT_LENGTH + 1) },
  }, DONE)
  assert.equal(oversized.ok, false)

  const malformed = structuredClone(running)
  malformed.runs[0].taskId = 'missing'
  assert.equal(validateTaskSession(malformed).ok, false)
})

test('persists, restores and clears only validated latest sessions', async () => {
  const values = new Map()
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  }
  const store = new LocalTaskSessionStore(storage)
  const session = mustUpdate(mustCreate(), {
    type: 'set-task-dependencies',
    taskId: 'task-2',
    dependsOn: [],
  })

  assert.deepEqual(await store.save(session), { ok: true })
  assert.deepEqual((await store.loadLatest()).session, session)
  assert.deepEqual((await store.loadLatest()).session.plan.tasks[1].dependsOn, [])
  assert.equal(values.has(TASK_SESSION_STORAGE_KEY), true)
  assert.deepEqual(await store.clear(), { ok: true })
  assert.deepEqual(await store.loadLatest(), { ok: true, session: null })

  values.set(TASK_SESSION_STORAGE_KEY, '{broken')
  const corrupt = await store.loadLatest()
  assert.equal(corrupt.ok, false)
  assert.equal(corrupt.code, 'CORRUPT_DATA')
  assert.equal(values.get(TASK_SESSION_STORAGE_KEY), '{broken')
})

test('returns safe errors for unavailable storage and oversized sessions', async () => {
  const unavailable = new LocalTaskSessionStore({
    getItem() { throw new Error('private read failure') },
    setItem() { throw new Error('private write failure') },
    removeItem() { throw new Error('private clear failure') },
  })
  for (const outcome of [
    await unavailable.loadLatest(),
    await unavailable.save(mustCreate()),
    await unavailable.clear(),
  ]) {
    assert.equal(outcome.ok, false)
    assert.equal(outcome.code, 'STORAGE_UNAVAILABLE')
    assert.equal(outcome.message.includes('private'), false)
  }

  const oversized = mustCreate()
  oversized.analysisResult.assumptions = ['x'.repeat(2 * 1024 * 1024)]
  const memoryStore = new LocalTaskSessionStore({
    getItem: () => null,
    setItem() {},
    removeItem() {},
  })
  const outcome = await memoryStore.save(oversized)
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'LIMIT_EXCEEDED')
})

test('uses only accepted dependency summaries in the next task prompt', () => {
  const session = completeFirstTask(mustCreate())
  const nextTask = session.plan.tasks[1]
  const dependencyResult = session.runs[0].result
  const prompt = buildManualTaskPrompt(nextTask, session.plan, 'codex', [dependencyResult])

  assert.match(prompt, /已验收的前置结果摘要/)
  assert.match(prompt, /方案摘要/)
  assert.equal(prompt.includes('FULL_PRIVATE_RESULT'), false)
})

test('completes final verification and generates a summary-only Markdown report', () => {
  let session = completeFirstTask(mustCreate())
  session = mustUpdate(session, { type: 'start', taskId: 'task-2' })
  session = mustUpdate(session, {
    type: 'update-draft',
    taskId: 'task-2',
    draft: {
      outputText: '实现摘要\n\nSECOND_FULL_PRIVATE_RESULT',
      verification: [{ label: '实现通过检查', status: 'passed' }],
    },
  })
  session = mustUpdate(session, { type: 'submit-result', taskId: 'task-2' })
  session = mustUpdate(session, { type: 'accept', taskId: 'task-2' }, DONE)
  assert.equal(generateTaskSessionReport(session).ok, false)

  session = mustUpdate(session, { type: 'set-final-verification', index: 0, status: 'passed' }, DONE)
  session = mustUpdate(session, { type: 'set-final-verification', index: 1, status: 'passed' }, DONE)
  assert.equal(session.completedAt, DONE)

  const report = generateTaskSessionReport(session)
  assert.equal(report.ok, true)
  assert.match(report.markdown, /方案摘要/)
  assert.match(report.markdown, /实现摘要/)
  assert.match(report.markdown, /人工确认方案可执行/)
  assert.equal(report.markdown.includes('FULL_PRIVATE_RESULT'), false)
  assert.equal(report.markdown.includes('SECOND_FULL_PRIVATE_RESULT'), false)
  assert.match(report.fileName, /\.md$/)
})
