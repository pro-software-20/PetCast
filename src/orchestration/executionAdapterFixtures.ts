import type {
  EvaluationReport,
  ExecutionAdapter,
  ExecutionAdapterError,
  ExecutionAdapterOutcome,
  ExecutionDispatchRequest,
  ExecutionReceipt,
  ExecutionReference,
  ExecutionSnapshot,
} from '../types/taskCoordination'
import type { TaskExecutionResult } from '../types/taskOrchestration'
import {
  validateExecutionDispatchRequest,
  validateExecutionReference,
  validateExecutionSnapshot,
} from './taskCoordinationValidation'

export type InMemoryExecutionHandler = (
  request: ExecutionDispatchRequest,
  signal: AbortSignal,
) => Promise<ExecutionAdapterOutcome<TaskExecutionResult>>

interface StoredExecution {
  request: ExecutionDispatchRequest
  receipt: ExecutionReceipt
  snapshot: ExecutionSnapshot
  controller: AbortController
}

const safeError = (
  code: ExecutionAdapterError['code'],
  message: string,
  retryable = false,
): ExecutionAdapterError => ({ code, message, retryable })

const invalid = <T>(message: string): ExecutionAdapterOutcome<T> => ({
  ok: false,
  error: safeError('INVALID_INPUT', message),
})

const cancelled = <T>(): ExecutionAdapterOutcome<T> => ({
  ok: false,
  error: safeError('CANCELLED', '执行请求已取消。'),
})

/**
 * A zero-network fixture for P3.1 scheduler tests and A/B integration tests.
 * It intentionally stores executions in memory and never resumes work after restart.
 */
export class InMemoryExecutionAdapter implements ExecutionAdapter {
  private readonly executions = new Map<string, StoredExecution>()
  private calls = 0

  constructor(private readonly handler: InMemoryExecutionHandler) {}

  get dispatchCallCount() {
    return this.calls
  }

  async dispatch(
    request: ExecutionDispatchRequest,
    signal?: AbortSignal,
  ): Promise<ExecutionAdapterOutcome<ExecutionReceipt>> {
    if (signal?.aborted) return cancelled()
    const validation = validateExecutionDispatchRequest(request)
    if (!validation.ok) return invalid('执行派发请求未通过严格校验。')

    const existing = this.executions.get(request.dispatchId)
    if (existing) {
      return JSON.stringify(existing.request) === JSON.stringify(request)
        ? { ok: true, value: existing.receipt }
        : invalid('同一 dispatchId 不能对应不同执行请求。')
    }

    const acceptedAt = new Date().toISOString()
    const adapterExecutionId = `memory:${request.dispatchId}`
    const receipt: ExecutionReceipt = {
      dispatchId: request.dispatchId,
      adapterExecutionId,
      taskId: request.taskId,
      state: 'queued',
      acceptedAt,
    }
    const controller = new AbortController()
    const stored: StoredExecution = {
      request,
      receipt,
      controller,
      snapshot: {
        dispatchId: request.dispatchId,
        adapterExecutionId,
        taskId: request.taskId,
        state: 'queued',
        observedAt: acceptedAt,
      },
    }
    this.executions.set(request.dispatchId, stored)
    this.calls += 1

    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    void this.run(stored).finally(() => signal?.removeEventListener('abort', abort))
    return { ok: true, value: receipt }
  }

  async inspect(
    reference: ExecutionReference,
    signal?: AbortSignal,
  ): Promise<ExecutionAdapterOutcome<ExecutionSnapshot>> {
    if (signal?.aborted) return cancelled()
    const found = this.find(reference)
    return found.ok ? { ok: true, value: found.value.snapshot } : found
  }

  async cancel(
    reference: ExecutionReference,
    signal?: AbortSignal,
  ): Promise<ExecutionAdapterOutcome<ExecutionSnapshot>> {
    if (signal?.aborted) return cancelled()
    const found = this.find(reference)
    if (!found.ok) return found
    const stored = found.value
    if (!['completed', 'failed', 'cancelled'].includes(stored.snapshot.state)) {
      stored.controller.abort()
      stored.snapshot = {
        ...reference,
        state: 'cancelled',
        observedAt: new Date().toISOString(),
        error: safeError('CANCELLED', '执行已取消。'),
      }
    }
    return { ok: true, value: stored.snapshot }
  }

  private find(
    reference: ExecutionReference,
  ): ExecutionAdapterOutcome<StoredExecution> {
    const validation = validateExecutionReference(reference)
    if (!validation.ok) return invalid('执行引用未通过严格校验。')
    const stored = this.executions.get(reference.dispatchId)
    if (!stored
      || stored.receipt.adapterExecutionId !== reference.adapterExecutionId
      || stored.request.taskId !== reference.taskId) {
      return {
        ok: false,
        error: safeError('EXECUTION_NOT_FOUND', '未找到匹配的执行记录。'),
      }
    }
    return { ok: true, value: stored }
  }

  private async run(stored: StoredExecution) {
    if (stored.controller.signal.aborted) return
    stored.snapshot = {
      dispatchId: stored.request.dispatchId,
      adapterExecutionId: stored.receipt.adapterExecutionId,
      taskId: stored.request.taskId,
      state: 'running',
      observedAt: new Date().toISOString(),
    }
    try {
      const outcome = await this.handler(stored.request, stored.controller.signal)
      if (stored.controller.signal.aborted || stored.snapshot.state === 'cancelled') return
      stored.snapshot = outcome.ok
        ? {
            dispatchId: stored.request.dispatchId,
            adapterExecutionId: stored.receipt.adapterExecutionId,
            taskId: stored.request.taskId,
            state: 'completed',
            observedAt: new Date().toISOString(),
            result: outcome.value,
          }
        : {
            dispatchId: stored.request.dispatchId,
            adapterExecutionId: stored.receipt.adapterExecutionId,
            taskId: stored.request.taskId,
            state: outcome.error.code === 'NEEDS_INPUT' ? 'needs-input' : 'failed',
            observedAt: new Date().toISOString(),
            error: outcome.error,
          }
      const snapshotValidation = validateExecutionSnapshot(stored.snapshot, {
        dispatchId: stored.request.dispatchId,
        taskId: stored.request.taskId,
        providerId: stored.request.providerId,
      })
      if (!snapshotValidation.ok) {
        stored.snapshot = {
          dispatchId: stored.request.dispatchId,
          adapterExecutionId: stored.receipt.adapterExecutionId,
          taskId: stored.request.taskId,
          state: 'failed',
          observedAt: new Date().toISOString(),
          error: safeError('INVALID_RESPONSE', '执行器返回了不匹配或无效的结果。'),
        }
      }
    } catch {
      if (stored.controller.signal.aborted || stored.snapshot.state === 'cancelled') return
      stored.snapshot = {
        dispatchId: stored.request.dispatchId,
        adapterExecutionId: stored.receipt.adapterExecutionId,
        taskId: stored.request.taskId,
        state: 'failed',
        observedAt: new Date().toISOString(),
        error: safeError('FAILED', '执行器发生安全封装后的内部错误。', true),
      }
    }
  }
}

export const createEvaluationReportFixture = (
  overrides: Partial<EvaluationReport> = {},
): EvaluationReport => ({
  evaluationId: 'evaluation-fixture-1',
  dispatchId: 'dispatch-fixture-1',
  taskId: 'task-fixture-1',
  verdict: 'accepted',
  verification: [{ label: '输出满足任务要求', status: 'passed' }],
  method: 'rubric',
  ruleVersion: 'fixture-v1',
  comparisonBasis: '按任务验收标准逐项核对。',
  evidence: [{
    type: 'test-log',
    reference: 'ledger:test-log:fixture-1',
    summary: '零依赖测试通过。',
  }],
  note: '',
  createdAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
})

