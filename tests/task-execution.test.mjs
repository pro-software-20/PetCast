import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { loadTs } from './load-ts.mjs'

const protocol = await loadTs('../electron/taskExecutionProtocol.ts')
const sandbox = await loadTs('../electron/taskExecutionSandbox.ts')
const { CodexAppServerSession } = await loadTs('../electron/codexAppServer.ts')
const { TaskExecutionManager } = await loadTs('../electron/taskExecutionManager.ts')
const { createTaskSession, updateTaskSession, recoverInterruptedTaskExecutions } = await loadTs('../src/orchestration/taskSession.ts')

const scope = {
  readPaths: ['src', 'tests'],
  allowedWritePaths: ['src'],
  forbiddenPaths: ['src/private'],
  outputPaths: ['src/generated.ts'],
}

const managerRequest = workspaceId => ({
  requestId: 'prepare-test',
  taskId: 'task-1',
  workspaceId,
  expectedScopeId: `codex-${'b'.repeat(64)}`,
  authMode: 'local-codex-experimental',
  prompt: '修改授权代码',
  category: 'coding',
  scope: { readPaths: ['src'], allowedWritePaths: ['src'], forbiddenPaths: [], outputPaths: [] },
  dependencySummaries: [],
})

test('execution request accepts only metadata, safe paths and coding/testing categories', () => {
  const request = {
    requestId: 'prepare-1', taskId: 'task-1', workspaceId: 'a'.repeat(64),
    expectedScopeId: `codex-${'b'.repeat(64)}`, prompt: '修复代码', category: 'coding',
    authMode: 'local-codex-experimental',
    scope, dependencySummaries: ['前置任务已完成'], unknown: 'stripped only by rejection boundary',
  }
  const checked = protocol.validatePrepareCodexTaskExecutionRequest(request)
  assert.equal(checked.prompt, '修复代码')
  assert.throws(() => protocol.validatePrepareCodexTaskExecutionRequest({ ...request, category: 'writing' }))
  assert.throws(() => protocol.validatePrepareCodexTaskExecutionRequest({ ...request, scope: { ...scope, readPaths: ['../secret'] } }))
  assert.equal(JSON.stringify(checked).includes('absolutePath'), false)
})

test('isolated workspace stages authorized UTF-8 text and applies a reviewed modification', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'petcast-source-'))
  const stagedRoot = await mkdtemp(path.join(os.tmpdir(), 'petcast-stage-'))
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(stagedRoot, { recursive: true, force: true })]))
  await mkdir(path.join(root, 'src', 'private'), { recursive: true })
  await mkdir(path.join(root, 'tests'), { recursive: true })
  await writeFile(path.join(root, 'src', 'app.ts'), 'export const value = 1\n')
  await writeFile(path.join(root, 'src', 'private', 'secret.ts'), 'secret\n')
  await writeFile(path.join(root, 'tests', 'app.test.ts'), 'test\n')
  const staged = await sandbox.stageTaskWorkspace({ root, stagedRoot, scope })
  assert.deepEqual([...staged.baseline.keys()].sort(), ['src/app.ts', 'tests/app.test.ts'])
  await writeFile(path.join(stagedRoot, 'src', 'app.ts'), 'export const value = 2\n')
  const artifact = await sandbox.createTaskExecutionArtifact(staged)
  assert.deepEqual(artifact.changes.map(change => change.path), ['src/app.ts'])
  assert.match(artifact.diff, /\+export const value = 2/)
  await sandbox.applyTaskExecutionArtifact(artifact)
  assert.equal(await readFile(path.join(root, 'src', 'app.ts'), 'utf8'), 'export const value = 2\n')
  assert.equal(await readFile(path.join(root, 'src', 'private', 'secret.ts'), 'utf8'), 'secret\n')
})

test('sandbox rejects source races, deletions, forbidden changes and binary input', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'petcast-source-'))
  const stagedRoot = await mkdtemp(path.join(os.tmpdir(), 'petcast-stage-'))
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(stagedRoot, { recursive: true, force: true })]))
  await mkdir(path.join(root, 'src'), { recursive: true })
  await writeFile(path.join(root, 'src', 'app.ts'), 'one\n')
  const staged = await sandbox.stageTaskWorkspace({ root, stagedRoot, scope: { ...scope, readPaths: ['src'], forbiddenPaths: [] } })
  await writeFile(path.join(stagedRoot, 'src', 'app.ts'), 'two\n')
  const artifact = await sandbox.createTaskExecutionArtifact(staged)
  await writeFile(path.join(root, 'src', 'app.ts'), 'teammate change\n')
  await assert.rejects(() => sandbox.applyTaskExecutionArtifact(artifact), error => error.code === 'SOURCE_CHANGED')

  const second = await mkdtemp(path.join(os.tmpdir(), 'petcast-stage-'))
  t.after(() => rm(second, { recursive: true, force: true }))
  const staged2 = await sandbox.stageTaskWorkspace({ root, stagedRoot: second, scope: { ...scope, readPaths: ['src'], forbiddenPaths: [] } })
  await rm(path.join(second, 'src', 'app.ts'))
  await assert.rejects(() => sandbox.createTaskExecutionArtifact(staged2), error => error.code === 'UNSAFE_CHANGES')

  await writeFile(path.join(root, 'src', 'binary.bin'), Buffer.from([0, 1, 2]))
  const third = await mkdtemp(path.join(os.tmpdir(), 'petcast-stage-'))
  t.after(() => rm(third, { recursive: true, force: true }))
  await assert.rejects(() => sandbox.stageTaskWorkspace({ root, stagedRoot: third, scope: { ...scope, readPaths: ['src'], forbiddenPaths: [] } }), error => error.code === 'UNSAFE_CHANGES')
})

function fakeChild(messages) {
  const child = new EventEmitter()
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.killed = false
  child.kill = () => { child.killed = true; return true }
  child.stdin.on('data', chunk => {
    for (const line of chunk.toString().trim().split('\n')) {
      if (!line) continue
      const request = JSON.parse(line)
      messages.push(request)
      if (!request.id) continue
      let result = {}
      if (request.method === 'account/read') result = { account: { type: 'chatgpt', email: 'person@example.com' } }
      if (request.method === 'account/rateLimits/read') result = { accountId: 'workspace-a' }
      if (request.method === 'thread/start') result = { thread: { id: 'thread-1', model: 'gpt-test' } }
      if (request.method === 'turn/start') {
        result = { turn: { id: 'turn-1' } }
        queueMicrotask(() => {
          child.stdout.write(`${JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: '完成修改' } })}\n`)
          child.stdout.write(`${JSON.stringify({ method: 'thread/tokenUsage/updated', params: { tokenUsage: { total: { inputTokens: 12, outputTokens: 4, cachedInputTokens: 2 } } } })}\n`)
          child.stdout.write(`${JSON.stringify({ method: 'turn/completed', params: { turn: { status: 'completed' } } })}\n`)
        })
      }
      child.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`)
    }
  })
  return child
}

test('app-server performs handshake, verifies scope and reports streamed output and provider tokens', async () => {
  const messages = []
  const expectedScope = `codex-${'c'.repeat(64)}`
  const session = new CodexAppServerSession(
    'C:/isolated',
    { getSalt: async () => 'salt', hashAccount: async () => expectedScope },
    () => {},
    () => fakeChild(messages),
    async () => ({ executable: 'fake', source: 'explicit' }),
  )
  assert.equal(await session.prepare(expectedScope), 'gpt-test')
  const result = await session.run('只修改授权文件')
  assert.equal(result.outputText, '完成修改')
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 4, cachedInputTokens: 2 })
  const initialize = messages.find(message => message.method === 'initialize')
  assert.equal(initialize.params.capabilities, null)
  const turn = messages.find(message => message.method === 'turn/start')
  assert.equal(turn.params.approvalPolicy, 'never')
  assert.equal(turn.params.sandboxPolicy.networkAccess, false)
  session.close()
})

test('OAuth app-server receives the access token only through its child environment', async () => {
  const messages = []
  const launches = []
  const expectedScope = `codex-${'f'.repeat(64)}`
  const session = new CodexAppServerSession(
    'C:/isolated',
    { getSalt: async () => 'salt', hashAccount: async () => expectedScope },
    () => {},
    (_executable, _cwd, args, environment) => {
      launches.push({ args, environment })
      return fakeChild(messages)
    },
    async () => ({ executable: 'fake', source: 'explicit' }),
  )
  assert.equal(await session.prepare(expectedScope, {
    mode: 'chatgpt-oauth',
    accessToken: 'oauth-secret-token',
  }), 'gpt-test')
  assert.equal(launches[0].environment.ACCESS_TOKEN, 'oauth-secret-token')
  assert.equal(launches[0].args.some(value => value.includes('openai_chatgpt_plan')), true)
  assert.equal(messages.some(message => message.method === 'account/read'), false)
  assert.equal(messages.some(message => message.method === 'account/rateLimits/read'), false)
  assert.doesNotMatch(JSON.stringify(messages), /oauth-secret-token/)
  session.close()
})

function statusChild(status, lateStatus) {
  const child = new EventEmitter()
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.killed = false
  child.kill = () => { child.killed = true; return true }
  child.stdin.on('data', chunk => {
    for (const line of chunk.toString().trim().split('\n')) {
      if (!line) continue
      const request = JSON.parse(line)
      if (!request.id) continue
      let result = {}
      if (request.method === 'account/read') result = { account: { type: 'chatgpt', email: 'person@example.com' } }
      if (request.method === 'account/rateLimits/read') result = { accountId: 'workspace-a' }
      if (request.method === 'thread/start') result = { thread: { id: 'thread-1', model: 'gpt-test' } }
      if (request.method === 'turn/start') {
        result = { turn: { id: 'turn-1' } }
        queueMicrotask(() => {
          child.stdout.write(`${JSON.stringify({ method: 'turn/completed', params: { turn: { status } } })}\n`)
          if (lateStatus) child.stdout.write(`${JSON.stringify({ method: 'turn/completed', params: { turn: { status: lateStatus } } })}\n`)
        })
      }
      child.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`)
    }
  })
  return child
}

for (const status of ['failed', 'interrupted']) {
  test(`app-server treats ${status} as failure and ignores a late completed event`, async () => {
    const expectedScope = `codex-${'e'.repeat(64)}`
    const session = new CodexAppServerSession(
      'C:/isolated',
      { getSalt: async () => 'salt', hashAccount: async () => expectedScope },
      () => {},
      () => statusChild(status, 'completed'),
      async () => ({ executable: 'fake', source: 'explicit' }),
    )
    await session.prepare(expectedScope)
    await assert.rejects(() => session.run('只修改授权文件'), error => (
      error.code === (status === 'interrupted' ? 'CANCELLED' : 'PROVIDER_FAILED')
    ))
    session.close()
  })
}

test('manager cancels preparation by request id and rejects a late prepared result', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'petcast-manager-source-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspaceId = 'a'.repeat(64)
  let stagedRoot
  let stageStarted
  const started = new Promise(resolve => { stageStarted = resolve })
  const events = []
  const manager = new TaskExecutionManager(
    { get: id => id === workspaceId ? root : undefined },
    {},
    event => events.push(event),
    {
      experimentalLocalAuth: true,
      stageWorkspace: ({ stagedRoot: nextRoot, signal }) => new Promise((resolve, reject) => {
        stagedRoot = nextRoot
        stageStarted()
        signal.addEventListener('abort', () => reject(new Error('late preparation cancelled')), { once: true })
      }),
      createServer: () => { throw new Error('server must not start') },
    },
  )
  t.after(() => manager.dispose())
  const pending = manager.prepare(managerRequest(workspaceId))
  await started
  const cancelled = await manager.cancel('prepare-test')
  assert.equal(cancelled.ok, true)
  const result = await pending
  assert.equal(result.ok, false)
  assert.equal(result.code, 'CANCELLED')
  await assert.rejects(() => stat(stagedRoot), error => error.code === 'ENOENT')
  assert.equal(events.some(event => event.executionId === 'prepare-test' && event.code === 'CANCELLED'), true)
})

test('manager obtains OAuth credentials in the main process and never returns the token', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'petcast-manager-source-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, 'src'), { recursive: true })
  await writeFile(path.join(root, 'src', 'app.ts'), 'before\n')
  const workspaceId = '9'.repeat(64)
  const expectedScopeId = `codex-${'8'.repeat(64)}`
  const calls = []
  const manager = new TaskExecutionManager(
    { get: id => id === workspaceId ? root : undefined },
    {},
    () => {},
    {
      auth: {
        getAccessToken: async scopeId => {
          calls.push(['token', scopeId])
          return { accessToken: 'main-process-secret', scopeId }
        },
      },
      createServer: () => ({
        prepare: async (scopeId, auth) => {
          calls.push(['prepare', scopeId, auth])
          return 'gpt-test'
        },
        run: async () => ({ outputText: '', usage: null }),
        interrupt: async () => {},
        close: () => {},
      }),
    },
  )
  t.after(() => manager.dispose())
  const result = await manager.prepare({
    ...managerRequest(workspaceId),
    expectedScopeId,
    authMode: 'chatgpt-oauth',
  })
  assert.equal(result.ok, true)
  assert.deepEqual(calls, [
    ['token', expectedScopeId],
    ['prepare', expectedScopeId, { mode: 'chatgpt-oauth', accessToken: 'main-process-secret' }],
  ])
  assert.doesNotMatch(JSON.stringify(result), /main-process-secret/)
})

async function createManagerArtifact(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'petcast-manager-source-'))
  await mkdir(path.join(root, 'src'), { recursive: true })
  await writeFile(path.join(root, 'src', 'app.ts'), 'before\n')
  const workspaceId = 'd'.repeat(64)
  const events = []
  const manager = new TaskExecutionManager(
    { get: id => id === workspaceId ? root : undefined },
    {},
    event => events.push(event),
    {
      experimentalLocalAuth: true,
      artifactTtlMs: options.artifactTtlMs ?? 60_000,
      cleanupRetryDelaysMs: options.cleanupRetryDelaysMs ?? [],
      createServer: stagedRoot => ({
        prepare: async () => 'gpt-test',
        run: async () => {
          await writeFile(path.join(stagedRoot, 'src', 'app.ts'), 'after\n')
          return { outputText: '修改完成', usage: { inputTokens: 10, outputTokens: 3, cachedInputTokens: 1 } }
        },
        interrupt: async () => {},
        close: () => {},
      }),
      ...(options.discardArtifact ? { discardArtifact: options.discardArtifact } : {}),
    },
  )
  t.after(async () => {
    await manager.dispose()
    await rm(root, { recursive: true, force: true })
  })
  const prepared = await manager.prepare(managerRequest(workspaceId))
  assert.equal(prepared.ok, true)
  const result = await manager.run(prepared.value.executionId)
  assert.equal(result.ok, true)
  return { manager, root, events, executionId: prepared.value.executionId, result: result.value }
}

test('manager expires review artifacts and emits a structured interruption', async t => {
  const item = await createManagerArtifact(t, { artifactTtlMs: 10 })
  await new Promise(resolve => setTimeout(resolve, 40))
  const read = item.manager.readArtifact(item.result.artifactId)
  assert.equal(read.ok, false)
  assert.equal(read.code, 'ARTIFACT_EXPIRED')
  assert.equal(item.events.some(event => (
    event.executionId === item.executionId && event.code === 'ARTIFACT_EXPIRED'
  )), true)
})

test('successful apply is not reported as failed when temporary cleanup fails', async t => {
  let cleanupAttempts = 0
  const item = await createManagerArtifact(t, {
    discardArtifact: async () => {
      cleanupAttempts += 1
      throw new Error('temporary cleanup failure with an internal path')
    },
  })
  const applied = await item.manager.applyArtifact(item.result.artifactId)
  assert.equal(applied.ok, true)
  assert.equal(await readFile(path.join(item.root, 'src', 'app.ts'), 'utf8'), 'after\n')
  assert.equal(cleanupAttempts, 1)
  assert.equal(item.manager.readArtifact(item.result.artifactId).code, 'ARTIFACT_NOT_FOUND')
})

test('discard cleanup failure is structured and leaves the artifact retryable', async t => {
  let shouldFail = true
  const item = await createManagerArtifact(t, {
    discardArtifact: async artifact => {
      if (shouldFail) throw new Error(`do not expose ${artifact.stagedRoot}`)
      await rm(artifact.stagedRoot, { recursive: true, force: true })
    },
  })
  const first = await item.manager.discardArtifact(item.result.artifactId)
  assert.deepEqual(first, {
    ok: false,
    code: 'CLEANUP_FAILED',
    message: protocol.TASK_EXECUTION_MESSAGES.CLEANUP_FAILED,
  })
  shouldFail = false
  assert.equal((await item.manager.discardArtifact(item.result.artifactId)).ok, true)
})

const analysis = {
  taskType: 'coding', complexity: 'low', estimatedInputTokens: { min: 1, max: 2 }, estimatedOutputTokens: { min: 1, max: 2 },
  estimationBasis: 'heuristic-metadata', assumptions: [], optimizedPrompt: 'fix', promptOptimizationSource: 'local',
  canRunInParallel: false, parallelPlan: [], warnings: [],
}
const plan = {
  schemaVersion: 1, id: 'plan-1', title: 'Plan', goal: 'Fix', assumptions: [],
  workspace: { id: 'a'.repeat(64), displayName: 'demo' },
  tasks: [{ id: 'task-1', title: 'Fix', description: 'Fix code', dependsOn: [], recommendedProviderId: 'codex',
    providerRecommendation: { category: 'coding', requiredCapabilities: ['coding'], confidence: 'high', reason: '代码任务' },
    executionMode: 'manual', prompt: 'fix', files: { inputs: [], readPaths: ['src'], allowedWritePaths: ['src'], forbiddenPaths: [], outputPaths: [] },
    expectedDeliverables: ['code'], acceptanceChecks: ['tests pass'] }], finalAcceptanceChecks: ['done'],
}

test('automatic session requires artifact resolution and recovers interrupted desktop state without rerun', () => {
  const created = createTaskSession({ analysisInput: { prompt: 'fix', files: [] }, analysisResult: analysis, plan })
  assert.equal(created.ok, true)
  const started = updateTaskSession(created.session, { type: 'start-automatic', taskId: 'task-1', executionId: 'exec-1', model: 'gpt-test' })
  assert.equal(started.ok, true)
  const completed = updateTaskSession(started.session, { type: 'complete-automatic', taskId: 'task-1', artifactId: 'artifact-1', summary: 'done', outputText: 'done', changedFiles: ['src/app.ts'] })
  assert.equal(completed.ok, true)
  const expired = updateTaskSession(completed.session, { type: 'interrupt-automatic', taskId: 'task-1', message: 'artifact expired' })
  assert.equal(expired.ok, true)
  assert.equal(expired.session.runs[0].status, 'needs-input')
  assert.equal(expired.session.runs[0].automaticExecution.state, 'interrupted')
  assert.equal(expired.session.runs[0].automaticExecution.artifactId, undefined)
  assert.equal(updateTaskSession(completed.session, { type: 'accept', taskId: 'task-1' }).ok, false)
  const applied = updateTaskSession(completed.session, { type: 'apply-automatic', taskId: 'task-1' })
  assert.equal(applied.ok, true)
  const verified = updateTaskSession(applied.session, { type: 'set-automatic-verification', taskId: 'task-1', index: 0, status: 'passed' })
  assert.equal(verified.ok, true)
  assert.equal(updateTaskSession(verified.session, { type: 'accept', taskId: 'task-1' }).ok, true)
  const restored = recoverInterruptedTaskExecutions(started.session)
  assert.equal(restored.runs[0].status, 'needs-input')
  assert.equal(restored.runs[0].automaticExecution.state, 'interrupted')
})
