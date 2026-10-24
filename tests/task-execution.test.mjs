import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { loadTs } from './load-ts.mjs'

const protocol = await loadTs('../electron/taskExecutionProtocol.ts')
const sandbox = await loadTs('../electron/taskExecutionSandbox.ts')
const { CodexAppServerSession } = await loadTs('../electron/codexAppServer.ts')
const { createTaskSession, updateTaskSession, recoverInterruptedTaskExecutions } = await loadTs('../src/orchestration/taskSession.ts')

const scope = {
  readPaths: ['src', 'tests'],
  allowedWritePaths: ['src'],
  forbiddenPaths: ['src/private'],
  outputPaths: ['src/generated.ts'],
}

test('execution request accepts only metadata, safe paths and coding/testing categories', () => {
  const request = {
    requestId: 'prepare-1', taskId: 'task-1', workspaceId: 'a'.repeat(64),
    expectedScopeId: `codex-${'b'.repeat(64)}`, prompt: '修复代码', category: 'coding',
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
  const turn = messages.find(message => message.method === 'turn/start')
  assert.equal(turn.params.approvalPolicy, 'never')
  assert.equal(turn.params.sandboxPolicy.networkAccess, false)
  session.close()
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
