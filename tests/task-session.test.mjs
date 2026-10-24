import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTs } from './load-ts.mjs'

const {
  canEditTaskPlan,
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

test('manual provider changes preserve the static recommendation record', () => {
  const recommendationPlan = plan()
  recommendationPlan.tasks[0].providerRecommendation = {
    category: 'planning',
    requiredCapabilities: ['planning'],
    confidence: 'high',
    reason: '需求分析适合结构化规划。',
  }
  const created = createTaskSession({ ...input(), plan: recommendationPlan }, NOW)
  assert.equal(created.ok, true)

  const assigned = mustUpdate(created.session, {
    type: 'assign-provider',
    taskId: 'task-1',
    providerId: 'doubao',
  })

  assert.equal(assigned.runs[0].assignedProviderId, 'doubao')
  assert.deepEqual(
    assigned.plan.tasks[0].providerRecommendation,
    recommendationPlan.tasks[0].providerRecommendation,
  )
  assert.equal(assigned.plan.tasks[0].recommendedProviderId, 'deepseek')
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

test('sets workspace context and clears old authorization only when the workspace changes', () => {
  const workspaceA = { id: 'a'.repeat(64), displayName: 'Project A' }
  const workspaceB = { id: 'b'.repeat(64), displayName: 'Project B' }
  let session = mustUpdate(mustCreate(), { type: 'set-workspace', workspace: workspaceA })
  const task = session.plan.tasks[0]
  session = mustUpdate(session, {
    type: 'update-task-definition',
    taskId: task.id,
    task: {
      title: task.title,
      description: task.description,
      prompt: task.prompt,
      files: {
        inputs: [{ kind: 'workspace', path: 'src/App.tsx' }],
        allowedWritePaths: ['src'],
        forbiddenPaths: ['src/private'],
        outputPaths: ['src/result.ts'],
      },
      expectedDeliverables: task.expectedDeliverables,
      acceptanceChecks: task.acceptanceChecks,
      recommendedProviderId: task.recommendedProviderId,
      providerRecommendation: task.providerRecommendation,
    },
  })

  const same = mustUpdate(session, { type: 'set-workspace', workspace: workspaceA })
  assert.deepEqual(same.plan.tasks[0].files, session.plan.tasks[0].files)

  const changed = mustUpdate(same, { type: 'set-workspace', workspace: workspaceB })
  assert.deepEqual(changed.plan.tasks[0].files, {
    inputs: [], readPaths: [], allowedWritePaths: [], forbiddenPaths: [], outputPaths: [],
  })
  assert.deepEqual(changed.plan.workspace, workspaceB)
  assert.equal(validateTaskSession(changed).ok, true)
})

test('updates an unstarted task, refreshes checks and follows a new recommendation', () => {
  const original = mustCreate()
  const before = structuredClone(original)
  const task = original.plan.tasks[0]
  const recommendation = {
    category: 'coding',
    requiredCapabilities: ['coding'],
    confidence: 'high',
    reason: 'The edited task now requires code changes.',
  }
  const updated = mustUpdate(original, {
    type: 'update-task-definition',
    taskId: task.id,
    task: {
      title: 'Implement parser',
      description: 'Implement the validated parser design.',
      prompt: 'Edit the parser and run its tests.',
      files: task.files,
      expectedDeliverables: ['Parser implementation'],
      acceptanceChecks: ['Typecheck passes', 'Parser tests pass'],
      recommendedProviderId: 'codex',
      providerRecommendation: recommendation,
    },
  })

  assert.deepEqual(original, before)
  assert.equal(updated.plan.tasks[0].title, 'Implement parser')
  assert.equal(updated.plan.tasks[0].recommendedProviderId, 'codex')
  assert.deepEqual(updated.plan.tasks[0].providerRecommendation, recommendation)
  assert.equal(updated.runs[0].assignedProviderId, 'codex')
  assert.deepEqual(updated.runs[0].draft.verification.map(item => item.label), [
    'Typecheck passes', 'Parser tests pass',
  ])
})

test('task editing preserves an explicit provider override and locks after execution starts', () => {
  let session = mustUpdate(mustCreate(), {
    type: 'assign-provider', taskId: 'task-1', providerId: 'doubao',
  })
  const task = session.plan.tasks[0]
  session = mustUpdate(session, {
    type: 'update-task-definition',
    taskId: task.id,
    task: {
      title: task.title,
      description: task.description,
      prompt: `${task.prompt} Add tests.`,
      files: task.files,
      expectedDeliverables: task.expectedDeliverables,
      acceptanceChecks: task.acceptanceChecks,
      recommendedProviderId: 'codex',
      providerRecommendation: {
        category: 'testing', requiredCapabilities: ['testing'], confidence: 'high', reason: 'Tests need execution.',
      },
    },
  })
  assert.equal(session.runs[0].assignedProviderId, 'doubao')
  assert.equal(canEditTaskPlan(session), true)

  const started = mustUpdate(session, { type: 'start', taskId: 'task-1' })
  assert.equal(canEditTaskPlan(started), false)
  assert.equal(updateTaskSession(started, {
    type: 'set-workspace',
    workspace: { id: 'c'.repeat(64), displayName: 'Locked' },
  }, DONE).code, 'INVALID_TRANSITION')
  assert.equal(updateTaskSession(started, {
    type: 'update-task-definition', taskId: task.id, task,
  }, DONE).code, 'INVALID_TRANSITION')
})

test('manual task prompts include only display name and authorized relative paths', () => {
  const workspacePlan = plan()
  workspacePlan.workspace = { id: 'd'.repeat(64), displayName: 'Safe Project' }
  workspacePlan.tasks[0].files = {
    inputs: [{ kind: 'workspace', path: 'src/App.tsx' }],
    readPaths: ['src/components'],
    allowedWritePaths: ['src'],
    forbiddenPaths: ['src/private'],
    outputPaths: ['src/result.ts'],
  }
  const prompt = buildManualTaskPrompt(workspacePlan.tasks[0], workspacePlan, 'codex')
  assert.match(prompt, /Safe Project/)
  assert.match(prompt, /src\/App\.tsx/)
  assert.match(prompt, /src\/components/)
  assert.match(prompt, /src\/result\.ts/)
  assert.equal(prompt.includes(workspacePlan.workspace.id), false)
  assert.equal(prompt.includes('C:\\'), false)
  assert.equal(prompt.includes('PRIVATE_FILE_CONTENT'), false)
})

test('legacy sessions without workspace metadata remain valid', () => {
  const session = mustCreate()
  assert.equal(session.plan.workspace, undefined)
  assert.equal(validateTaskSession(session).ok, true)
})

test('applies a global workspace scope atomically and preserves attachments', () => {
  const source = input()
  source.plan.tasks[0].files.inputs = [
    { kind: 'attachment', name: 'brief.pdf', type: 'application/pdf', size: 12 },
  ]
  const created = createTaskSession(source, NOW)
  assert.equal(created.ok, true)
  let session = mustUpdate(created.session, {
    type: 'set-workspace',
    workspace: { id: 'e'.repeat(64), displayName: 'Project' },
  })
  const scope = {
    readPaths: ['src'],
    allowedWritePaths: ['src'],
    forbiddenPaths: ['src/private'],
    outputPaths: ['src/result.ts'],
  }
  session = mustUpdate(session, {
    type: 'set-workspace-default-scope', scope, applyToAll: true,
  })
  assert.deepEqual(session.plan.workspace.defaultScope, scope)
  assert.deepEqual(session.plan.tasks[0].files.inputs, source.plan.tasks[0].files.inputs)
  assert.deepEqual(session.plan.tasks.map(task => task.files.readPaths), [['src'], ['src']])
  assert.equal(validateTaskSession(session).ok, true)
})

test('restores one task to the global scope and locks global edits after start', () => {
  let session = mustUpdate(mustCreate(), {
    type: 'set-workspace', workspace: { id: 'f'.repeat(64), displayName: 'Project' },
  })
  const scope = {
    readPaths: ['src'], allowedWritePaths: ['src'], forbiddenPaths: [], outputPaths: ['src/result.ts'],
  }
  session = mustUpdate(session, { type: 'set-workspace-default-scope', scope, applyToAll: true })
  const task = session.plan.tasks[0]
  session = mustUpdate(session, {
    type: 'update-task-definition',
    taskId: task.id,
    task: {
      title: task.title,
      description: task.description,
      prompt: task.prompt,
      files: { ...task.files, readPaths: ['docs'], allowedWritePaths: [], outputPaths: [] },
      expectedDeliverables: task.expectedDeliverables,
      acceptanceChecks: task.acceptanceChecks,
      recommendedProviderId: task.recommendedProviderId,
      providerRecommendation: task.providerRecommendation,
    },
  })
  assert.deepEqual(session.plan.tasks[0].files.readPaths, ['docs'])
  session = mustUpdate(session, { type: 'apply-workspace-default-scope', taskId: task.id })
  assert.deepEqual(session.plan.tasks[0].files.readPaths, ['src'])

  const started = mustUpdate(session, { type: 'start', taskId: 'task-1' })
  const locked = updateTaskSession(started, {
    type: 'set-workspace-default-scope', scope, applyToAll: true,
  }, DONE)
  assert.equal(locked.ok, false)
  assert.equal(locked.code, 'INVALID_TRANSITION')
})

test('switching workspaces clears default and task path scopes but keeps attachments', () => {
  const source = input()
  source.plan.tasks[0].files.inputs = [
    { kind: 'attachment', name: 'brief.txt', type: 'text/plain', size: 4 },
  ]
  const created = createTaskSession(source, NOW)
  assert.equal(created.ok, true)
  let session = mustUpdate(created.session, {
    type: 'set-workspace', workspace: { id: '1'.repeat(64), displayName: 'One' },
  })
  const scope = { readPaths: ['src'], allowedWritePaths: [], forbiddenPaths: [], outputPaths: [] }
  session = mustUpdate(session, { type: 'set-workspace-default-scope', scope, applyToAll: true })
  session = mustUpdate(session, {
    type: 'set-workspace', workspace: { id: '2'.repeat(64), displayName: 'Two' },
  })
  assert.equal(session.plan.workspace.defaultScope, undefined)
  assert.deepEqual(session.plan.tasks[0].files.inputs, source.plan.tasks[0].files.inputs)
  assert.deepEqual(session.plan.tasks[0].files.readPaths, [])
})
