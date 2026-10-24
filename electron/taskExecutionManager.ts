import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CodexAppServerError, CodexAppServerSession } from './codexAppServer.js'
import type { CodexScopeIdentity } from './codexScopeIdentity.js'
import {
  TASK_EXECUTION_MESSAGES,
  type CodexTaskExecutionResult,
  type PrepareCodexTaskExecutionRequest,
  type PreparedCodexTaskExecution,
  type TaskExecutionArtifactView,
  type TaskExecutionErrorCode,
  type TaskExecutionEvent,
  type TaskExecutionOutcome,
} from './taskExecutionProtocol.js'
import {
  TaskSandboxError,
  applyTaskExecutionArtifact,
  createTaskExecutionArtifact,
  discardTaskExecutionArtifact,
  stageTaskWorkspace,
  viewTaskExecutionArtifact,
  type StagedTaskWorkspace,
  type TaskExecutionArtifact,
} from './taskExecutionSandbox.js'
import type { WorkspaceRegistry } from './workspaceRegistry.js'

interface PreparedExecution {
  request: PrepareCodexTaskExecutionRequest
  staged: StagedTaskWorkspace
  server: CodexAppServerSession
  model: string
}

const resultError = <T>(code: TaskExecutionErrorCode): TaskExecutionOutcome<T> => ({
  ok: false,
  code,
  message: TASK_EXECUTION_MESSAGES[code],
})

const codeFor = (error: unknown): TaskExecutionErrorCode => {
  if (error instanceof TaskSandboxError || error instanceof CodexAppServerError) return error.code
  return 'PROVIDER_FAILED'
}

const summaryOf = (text: string, files: string[]) => {
  const first = text.trim().split(/\n\s*\n|\r?\n/)[0]?.replace(/\s+/g, ' ').trim()
  if (first) return first.length > 500 ? `${first.slice(0, 499)}…` : first
  return files.length ? `Codex 已生成 ${files.length} 个待审核文件改动。` : 'Codex 已完成任务，未产生文件改动。'
}

export class TaskExecutionManager {
  private readonly prepared = new Map<string, PreparedExecution>()
  private readonly artifacts = new Map<string, TaskExecutionArtifact>()
  private readonly expiryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private runningId?: string
  private preparing = false

  constructor(
    private readonly workspaces: WorkspaceRegistry,
    private readonly identity: CodexScopeIdentity,
    private readonly emit: (event: TaskExecutionEvent) => void,
  ) {}

  private expireLater(id: string, action: () => Promise<unknown>, delay: number) {
    const timer = setTimeout(() => {
      this.expiryTimers.delete(id)
      void action()
    }, delay)
    timer.unref?.()
    this.expiryTimers.set(id, timer)
  }

  private clearExpiry(id: string) {
    clearTimeout(this.expiryTimers.get(id))
    this.expiryTimers.delete(id)
  }

  async prepare(request: PrepareCodexTaskExecutionRequest): Promise<TaskExecutionOutcome<PreparedCodexTaskExecution>> {
    if (this.preparing || this.prepared.size > 0 || this.runningId) return resultError('CODEX_UNAVAILABLE')
    const root = this.workspaces.get(request.workspaceId)
    if (!root) return resultError('NO_WORKSPACE')
    this.preparing = true
    const executionId = randomUUID()
    const stagedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'petcast-codex-'))
    let server: CodexAppServerSession | undefined
    try {
      this.emit({ executionId, stage: 'preparing', message: '正在构建隔离副本并验证 Codex 账号…' })
      const staged = await stageTaskWorkspace({ root, stagedRoot, scope: request.scope })
      server = new CodexAppServerSession(stagedRoot, this.identity, message => {
        this.emit({ executionId, stage: 'running', message })
      })
      let prepareTimer: ReturnType<typeof setTimeout> | undefined
      const model = await Promise.race([
        server.prepare(request.expectedScopeId),
        new Promise<never>((_, reject) => {
          prepareTimer = setTimeout(() => reject(new CodexAppServerError('TIMEOUT')), 30_000)
        }),
      ]).finally(() => clearTimeout(prepareTimer))
      this.prepared.set(executionId, { request: structuredClone(request), staged, server, model })
      this.expireLater(executionId, () => this.cancel(executionId), 10 * 60_000)
      return { ok: true, value: {
        executionId,
        model,
        preparedFileCount: staged.preparedFileCount,
        preparedBytes: staged.preparedBytes,
        warnings: staged.warnings,
      } }
    } catch (error) {
      server?.close()
      await fs.rm(stagedRoot, { recursive: true, force: true }).catch(() => undefined)
      return resultError(codeFor(error))
    } finally {
      this.preparing = false
    }
  }

  async run(executionId: string): Promise<TaskExecutionOutcome<CodexTaskExecutionResult>> {
    const prepared = this.prepared.get(executionId)
    if (!prepared) return resultError('ARTIFACT_NOT_FOUND')
    if (this.runningId && this.runningId !== executionId) return resultError('CODEX_UNAVAILABLE')
    this.runningId = executionId
    this.clearExpiry(executionId)
    this.emit({ executionId, stage: 'running', message: 'Codex 已开始在隔离副本中执行。' })
    try {
      const output = await prepared.server.run(prepared.request.prompt)
      const artifact = await createTaskExecutionArtifact(prepared.staged)
      this.artifacts.set(artifact.id, artifact)
      this.prepared.delete(executionId)
      prepared.server.close()
      const changedFiles = artifact.changes.map(change => change.path)
      this.emit({ executionId, stage: 'review', message: '执行完成，请检查摘要与文件差异后决定是否应用。' })
      return { ok: true, value: {
        artifactId: artifact.id,
        summary: summaryOf(output.outputText, changedFiles),
        outputText: output.outputText,
        changedFiles,
        usage: output.usage,
      } }
    } catch (error) {
      prepared.server.close()
      this.prepared.delete(executionId)
      await fs.rm(prepared.staged.stagedRoot, { recursive: true, force: true }).catch(() => undefined)
      const code = codeFor(error)
      this.emit({ executionId, stage: code === 'CANCELLED' ? 'interrupted' : 'review', message: TASK_EXECUTION_MESSAGES[code] })
      return resultError(code)
    } finally {
      if (this.runningId === executionId) this.runningId = undefined
    }
  }

  async cancel(executionId: string): Promise<TaskExecutionOutcome<null>> {
    const prepared = this.prepared.get(executionId)
    if (!prepared) return resultError('ARTIFACT_NOT_FOUND')
    await prepared.server.interrupt()
    this.clearExpiry(executionId)
    this.prepared.delete(executionId)
    await fs.rm(prepared.staged.stagedRoot, { recursive: true, force: true }).catch(() => undefined)
    if (this.runningId === executionId) this.runningId = undefined
    this.emit({ executionId, stage: 'interrupted', message: '执行已取消，隔离副本已清理。' })
    return { ok: true, value: null }
  }

  readArtifact(artifactId: string): TaskExecutionOutcome<TaskExecutionArtifactView> {
    const artifact = this.artifacts.get(artifactId)
    return artifact ? { ok: true, value: viewTaskExecutionArtifact(artifact) } : resultError('ARTIFACT_NOT_FOUND')
  }

  async applyArtifact(artifactId: string): Promise<TaskExecutionOutcome<null>> {
    const artifact = this.artifacts.get(artifactId)
    if (!artifact) return resultError('ARTIFACT_NOT_FOUND')
    try {
      await applyTaskExecutionArtifact(artifact)
      this.clearExpiry(artifactId)
      await discardTaskExecutionArtifact(artifact)
      this.artifacts.delete(artifactId)
      return { ok: true, value: null }
    } catch (error) {
      return resultError(codeFor(error))
    }
  }

  async discardArtifact(artifactId: string): Promise<TaskExecutionOutcome<null>> {
    const artifact = this.artifacts.get(artifactId)
    if (!artifact) return resultError('ARTIFACT_NOT_FOUND')
    this.clearExpiry(artifactId)
    await discardTaskExecutionArtifact(artifact)
    this.artifacts.delete(artifactId)
    return { ok: true, value: null }
  }

  async dispose() {
    for (const timer of this.expiryTimers.values()) clearTimeout(timer)
    this.expiryTimers.clear()
    for (const item of this.prepared.values()) {
      item.server.close()
      await fs.rm(item.staged.stagedRoot, { recursive: true, force: true }).catch(() => undefined)
    }
    for (const artifact of this.artifacts.values()) {
      await discardTaskExecutionArtifact(artifact).catch(() => undefined)
    }
    this.prepared.clear()
    this.artifacts.clear()
  }
}
