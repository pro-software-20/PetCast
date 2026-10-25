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
  server: TaskExecutionServer
  model: string
}

interface TaskExecutionServer {
  prepare(expectedScopeId: string): Promise<string>
  run(prompt: string): Promise<{
    outputText: string
    usage: CodexTaskExecutionResult['usage']
  }>
  interrupt(): Promise<void>
  close(): void
}

interface PreparingExecution {
  requestId: string
  executionId: string
  controller: AbortController
  cancelled: boolean
  stagedRoot?: string
  server?: TaskExecutionServer
}

interface StoredArtifact {
  artifact: TaskExecutionArtifact
  executionId: string
}

export interface TaskExecutionManagerOptions {
  artifactTtlMs?: number
  prepareTimeoutMs?: number
  cleanupRetryDelaysMs?: readonly number[]
  createServer?: (
    stagedRoot: string,
    identity: CodexScopeIdentity,
    onProgress: (message: string) => void,
  ) => TaskExecutionServer
  stageWorkspace?: typeof stageTaskWorkspace
  createArtifact?: typeof createTaskExecutionArtifact
  applyArtifact?: typeof applyTaskExecutionArtifact
  discardArtifact?: typeof discardTaskExecutionArtifact
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
  private readonly artifacts = new Map<string, StoredArtifact>()
  private readonly expiredArtifactIds = new Set<string>()
  private readonly expiryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly cleanupTimers = new Set<ReturnType<typeof setTimeout>>()
  private readonly pendingCleanup = new Map<string, TaskExecutionArtifact>()
  private runningId?: string
  private preparing?: PreparingExecution
  private disposed = false

  private readonly artifactTtlMs: number
  private readonly prepareTimeoutMs: number
  private readonly cleanupRetryDelaysMs: readonly number[]
  private readonly createServer: NonNullable<TaskExecutionManagerOptions['createServer']>
  private readonly stageWorkspace: typeof stageTaskWorkspace
  private readonly createArtifact: typeof createTaskExecutionArtifact
  private readonly applyStoredArtifact: typeof applyTaskExecutionArtifact
  private readonly discardStoredArtifact: typeof discardTaskExecutionArtifact

  constructor(
    private readonly workspaces: WorkspaceRegistry,
    private readonly identity: CodexScopeIdentity,
    private readonly emit: (event: TaskExecutionEvent) => void,
    options: TaskExecutionManagerOptions = {},
  ) {
    this.artifactTtlMs = options.artifactTtlMs ?? 30 * 60_000
    this.prepareTimeoutMs = options.prepareTimeoutMs ?? 30_000
    this.cleanupRetryDelaysMs = options.cleanupRetryDelaysMs ?? [1_000, 5_000, 30_000]
    this.createServer = options.createServer ?? ((stagedRoot, identity, onProgress) => (
      new CodexAppServerSession(stagedRoot, identity, onProgress)
    ))
    this.stageWorkspace = options.stageWorkspace ?? stageTaskWorkspace
    this.createArtifact = options.createArtifact ?? createTaskExecutionArtifact
    this.applyStoredArtifact = options.applyArtifact ?? applyTaskExecutionArtifact
    this.discardStoredArtifact = options.discardArtifact ?? discardTaskExecutionArtifact
  }

  private expireLater(id: string, action: () => Promise<unknown>, delay: number) {
    this.clearExpiry(id)
    const timer = setTimeout(() => {
      this.expiryTimers.delete(id)
      void action()
    }, delay)
    timer.unref?.()
    this.expiryTimers.set(id, timer)
  }

  private clearExpiry(id: string) {
    const timer = this.expiryTimers.get(id)
    if (timer) clearTimeout(timer)
    this.expiryTimers.delete(id)
  }

  private rememberExpiredArtifact(artifactId: string) {
    this.expiredArtifactIds.add(artifactId)
    while (this.expiredArtifactIds.size > 100) {
      const oldest = this.expiredArtifactIds.values().next().value as string | undefined
      if (!oldest) break
      this.expiredArtifactIds.delete(oldest)
    }
  }

  private artifactMissing<T>(artifactId: string): TaskExecutionOutcome<T> {
    return resultError(this.expiredArtifactIds.has(artifactId) ? 'ARTIFACT_EXPIRED' : 'ARTIFACT_NOT_FOUND')
  }

  private async removeRoot(root: string): Promise<boolean> {
    try {
      await fs.rm(root, { recursive: true, force: true })
      return true
    } catch {
      return false
    }
  }

  private scheduleDetachedCleanup(artifact: TaskExecutionArtifact, attempt = 0) {
    this.pendingCleanup.set(artifact.id, artifact)
    const delay = this.cleanupRetryDelaysMs[attempt]
    if (delay === undefined || this.disposed) return
    const timer = setTimeout(() => {
      this.cleanupTimers.delete(timer)
      void this.discardStoredArtifact(artifact).then(() => {
        this.pendingCleanup.delete(artifact.id)
      }).catch(() => {
        this.scheduleDetachedCleanup(artifact, attempt + 1)
      })
    }, delay)
    timer.unref?.()
    this.cleanupTimers.add(timer)
  }

  private async cleanupAppliedArtifact(artifact: TaskExecutionArtifact) {
    try {
      await this.discardStoredArtifact(artifact)
    } catch {
      this.scheduleDetachedCleanup(artifact)
    }
  }

  private async expireArtifact(artifactId: string, attempt = 0): Promise<void> {
    const stored = this.artifacts.get(artifactId)
    if (!stored) return
    if (attempt === 0) {
      this.rememberExpiredArtifact(artifactId)
      this.emit({
        executionId: stored.executionId,
        stage: 'interrupted',
        code: 'ARTIFACT_EXPIRED',
        message: TASK_EXECUTION_MESSAGES.ARTIFACT_EXPIRED,
      })
    }
    try {
      await this.discardStoredArtifact(stored.artifact)
      this.artifacts.delete(artifactId)
    } catch {
      const delay = this.cleanupRetryDelaysMs[attempt]
      if (delay === undefined) {
        this.emit({
          executionId: stored.executionId,
          stage: 'review',
          code: 'CLEANUP_FAILED',
          message: TASK_EXECUTION_MESSAGES.CLEANUP_FAILED,
        })
        return
      }
      this.expireLater(artifactId, () => this.expireArtifact(artifactId, attempt + 1), delay)
    }
  }

  async prepare(request: PrepareCodexTaskExecutionRequest): Promise<TaskExecutionOutcome<PreparedCodexTaskExecution>> {
    if (this.disposed || this.preparing || this.prepared.size > 0 || this.runningId) return resultError('CODEX_UNAVAILABLE')
    const root = this.workspaces.get(request.workspaceId)
    if (!root) return resultError('NO_WORKSPACE')

    const context: PreparingExecution = {
      requestId: request.requestId,
      executionId: randomUUID(),
      controller: new AbortController(),
      cancelled: false,
    }
    this.preparing = context
    try {
      this.emit({ executionId: request.requestId, stage: 'preparing', message: '正在构建隔离副本并验证 Codex 账号…' })
      context.stagedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'petcast-codex-'))
      if (context.cancelled || context.controller.signal.aborted) throw new CodexAppServerError('CANCELLED')
      const staged = await this.stageWorkspace({
        root,
        stagedRoot: context.stagedRoot,
        scope: request.scope,
        signal: context.controller.signal,
      })
      if (context.cancelled || context.controller.signal.aborted) throw new CodexAppServerError('CANCELLED')
      const server = this.createServer(staged.stagedRoot, this.identity, message => {
        if (!context.cancelled) this.emit({ executionId: context.executionId, stage: 'running', message })
      })
      context.server = server
      let prepareTimer: ReturnType<typeof setTimeout> | undefined
      const model = await Promise.race([
        server.prepare(request.expectedScopeId),
        new Promise<never>((_, reject) => {
          prepareTimer = setTimeout(() => reject(new CodexAppServerError('TIMEOUT')), this.prepareTimeoutMs)
        }),
      ]).finally(() => {
        if (prepareTimer) clearTimeout(prepareTimer)
      })
      if (context.cancelled || context.controller.signal.aborted || this.preparing !== context) {
        throw new CodexAppServerError('CANCELLED')
      }
      this.prepared.set(context.executionId, { request: structuredClone(request), staged, server, model })
      this.expireLater(context.executionId, () => this.cancel(context.executionId), 10 * 60_000)
      return { ok: true, value: {
        executionId: context.executionId,
        model,
        preparedFileCount: staged.preparedFileCount,
        preparedBytes: staged.preparedBytes,
        warnings: staged.warnings,
      } }
    } catch (error) {
      context.server?.close()
      if (context.stagedRoot) await this.removeRoot(context.stagedRoot)
      const code = context.cancelled || context.controller.signal.aborted ? 'CANCELLED' : codeFor(error)
      return resultError(code)
    } finally {
      if (this.preparing === context) this.preparing = undefined
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
      const artifact = await this.createArtifact(prepared.staged)
      this.artifacts.set(artifact.id, { artifact, executionId })
      this.expireLater(artifact.id, () => this.expireArtifact(artifact.id), this.artifactTtlMs)
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
      await this.removeRoot(prepared.staged.stagedRoot)
      const code = codeFor(error)
      this.emit({
        executionId,
        stage: code === 'CANCELLED' ? 'interrupted' : 'review',
        code,
        message: TASK_EXECUTION_MESSAGES[code],
      })
      return resultError(code)
    } finally {
      if (this.runningId === executionId) this.runningId = undefined
    }
  }

  async cancel(id: string): Promise<TaskExecutionOutcome<null>> {
    const preparing = this.preparing
    if (preparing && (preparing.requestId === id || preparing.executionId === id)) {
      preparing.cancelled = true
      preparing.controller.abort()
      preparing.server?.close()
      if (this.preparing === preparing) this.preparing = undefined
      const cleaned = !preparing.stagedRoot || await this.removeRoot(preparing.stagedRoot)
      this.emit({
        executionId: preparing.requestId,
        stage: 'interrupted',
        code: cleaned ? 'CANCELLED' : 'CLEANUP_FAILED',
        message: cleaned ? TASK_EXECUTION_MESSAGES.CANCELLED : TASK_EXECUTION_MESSAGES.CLEANUP_FAILED,
      })
      return cleaned ? { ok: true, value: null } : resultError('CLEANUP_FAILED')
    }

    const prepared = this.prepared.get(id)
    if (!prepared) return resultError('ARTIFACT_NOT_FOUND')
    try {
      await prepared.server.interrupt()
    } catch {
      prepared.server.close()
    }
    this.clearExpiry(id)
    this.prepared.delete(id)
    const cleaned = await this.removeRoot(prepared.staged.stagedRoot)
    if (this.runningId === id) this.runningId = undefined
    this.emit({
      executionId: id,
      stage: 'interrupted',
      code: cleaned ? 'CANCELLED' : 'CLEANUP_FAILED',
      message: cleaned ? '执行已取消，隔离副本已清理。' : TASK_EXECUTION_MESSAGES.CLEANUP_FAILED,
    })
    return cleaned ? { ok: true, value: null } : resultError('CLEANUP_FAILED')
  }

  readArtifact(artifactId: string): TaskExecutionOutcome<TaskExecutionArtifactView> {
    if (this.expiredArtifactIds.has(artifactId)) return resultError('ARTIFACT_EXPIRED')
    const stored = this.artifacts.get(artifactId)
    return stored ? { ok: true, value: viewTaskExecutionArtifact(stored.artifact) } : this.artifactMissing(artifactId)
  }

  async applyArtifact(artifactId: string): Promise<TaskExecutionOutcome<null>> {
    if (this.expiredArtifactIds.has(artifactId)) return resultError('ARTIFACT_EXPIRED')
    const stored = this.artifacts.get(artifactId)
    if (!stored) return this.artifactMissing(artifactId)
    try {
      await this.applyStoredArtifact(stored.artifact)
    } catch (error) {
      return resultError(codeFor(error))
    }

    this.clearExpiry(artifactId)
    this.artifacts.delete(artifactId)
    this.emit({ executionId: stored.executionId, stage: 'applied', message: '文件改动已安全应用，临时副本正在清理。' })
    await this.cleanupAppliedArtifact(stored.artifact)
    return { ok: true, value: null }
  }

  async discardArtifact(artifactId: string): Promise<TaskExecutionOutcome<null>> {
    if (this.expiredArtifactIds.has(artifactId)) return resultError('ARTIFACT_EXPIRED')
    const stored = this.artifacts.get(artifactId)
    if (!stored) return this.artifactMissing(artifactId)
    try {
      await this.discardStoredArtifact(stored.artifact)
    } catch {
      return resultError('CLEANUP_FAILED')
    }
    this.clearExpiry(artifactId)
    this.artifacts.delete(artifactId)
    this.emit({ executionId: stored.executionId, stage: 'discarded', message: '待审核改动已丢弃，原项目未修改。' })
    return { ok: true, value: null }
  }

  async dispose() {
    this.disposed = true
    const preparing = this.preparing
    if (preparing) {
      preparing.cancelled = true
      preparing.controller.abort()
      preparing.server?.close()
      if (preparing.stagedRoot) await this.removeRoot(preparing.stagedRoot)
    }
    this.preparing = undefined
    for (const timer of this.expiryTimers.values()) clearTimeout(timer)
    this.expiryTimers.clear()
    for (const timer of this.cleanupTimers) clearTimeout(timer)
    this.cleanupTimers.clear()
    for (const item of this.prepared.values()) {
      item.server.close()
      await this.removeRoot(item.staged.stagedRoot)
    }
    for (const stored of this.artifacts.values()) {
      await this.discardStoredArtifact(stored.artifact).catch(() => undefined)
    }
    for (const artifact of this.pendingCleanup.values()) {
      await this.discardStoredArtifact(artifact).catch(() => undefined)
    }
    this.prepared.clear()
    this.artifacts.clear()
    this.pendingCleanup.clear()
  }
}
