import type {
  DeepSeekExecutionDispatchInput,
  DeepSeekExecutionOutcome,
  DeepSeekExecutionReceipt,
  DeepSeekExecutionReferenceInput,
  DeepSeekExecutionSnapshot,
} from '../../electron/deepSeekExecutionProtocol'
import type { ExecutionDispatchRequest } from '../types/taskCoordination'
import type {
  AdapterConformanceScenario,
  ExecutionAdapterConformanceFixture,
} from './adapterConformance'
import { DeepSeekExecutionAdapter } from './DeepSeekExecutionAdapter'
import type { DeepSeekExecutionClient } from './deepSeekExecutionClient'

const timestamp = '2026-01-01T00:00:00.000Z'
const error = (
  code: 'NEEDS_INPUT' | 'FAILED' | 'RATE_LIMITED' | 'CANCELLED' | 'EXECUTION_NOT_FOUND',
) => ({
  code,
  retryable: code === 'FAILED' || code === 'RATE_LIMITED',
  message: 'Safe fake provider error.',
  ...(code === 'RATE_LIMITED' ? { retryAfterSeconds: 30 } : {}),
})

export class FakeDeepSeekExecutionClient implements DeepSeekExecutionClient {
  providerStartCallCount = 0
  private request?: DeepSeekExecutionDispatchInput
  private receipt?: DeepSeekExecutionReceipt
  private cancelled = false

  constructor(private readonly scenario: AdapterConformanceScenario) {}

  async dispatch(
    request: DeepSeekExecutionDispatchInput,
    signal?: AbortSignal,
  ): Promise<DeepSeekExecutionOutcome<DeepSeekExecutionReceipt>> {
    if (signal?.aborted) return { ok: false, error: error('CANCELLED') }
    if (this.request) {
      return JSON.stringify(this.request) === JSON.stringify(request) && this.receipt
        ? { ok: true, value: structuredClone(this.receipt) }
        : {
            ok: false,
            error: { code: 'INVALID_INPUT', retryable: false, message: 'Conflicting dispatch id.' },
          }
    }
    this.providerStartCallCount += 1
    this.request = structuredClone(request)
    this.receipt = {
      dispatchId: request.dispatchId,
      adapterExecutionId: 'fake-deepseek-execution-1',
      taskId: request.taskId,
      state: 'queued',
      acceptedAt: timestamp,
    }
    return { ok: true, value: structuredClone(this.receipt) }
  }

  async inspect(
    reference: DeepSeekExecutionReferenceInput,
    signal?: AbortSignal,
  ): Promise<DeepSeekExecutionOutcome<DeepSeekExecutionSnapshot>> {
    if (signal?.aborted) return { ok: false, error: error('CANCELLED') }
    if (!this.request || !this.receipt
      || reference.dispatchId !== this.receipt.dispatchId
      || reference.adapterExecutionId !== this.receipt.adapterExecutionId
      || reference.taskId !== this.receipt.taskId) {
      return { ok: false, error: error('EXECUTION_NOT_FOUND') }
    }
    if (this.cancelled) return { ok: true, value: this.snapshot('cancelled', error('CANCELLED')) }
    if (this.scenario === 'cancel') return { ok: true, value: this.snapshot('running') }
    if (this.scenario === 'needs-input') return { ok: true, value: this.snapshot('needs-input', error('NEEDS_INPUT')) }
    if (this.scenario === 'failed') return { ok: true, value: this.snapshot('failed', error('FAILED')) }
    if (this.scenario === 'rate-limited') return { ok: true, value: this.snapshot('failed', error('RATE_LIMITED')) }
    return {
      ok: true,
      value: {
        ...reference,
        state: 'completed',
        observedAt: timestamp,
        result: {
          summary: 'DeepSeek fake execution completed.',
          outputText: 'Zero-network fixture output.',
          verification: this.request.acceptanceChecks.map(label => ({ label, status: 'not-run' })),
          usage: { inputTokens: 10, outputTokens: 5 },
        },
      },
    }
  }

  async cancel(
    reference: DeepSeekExecutionReferenceInput,
    signal?: AbortSignal,
  ): Promise<DeepSeekExecutionOutcome<DeepSeekExecutionSnapshot>> {
    const inspected = await this.inspect(reference, signal)
    if (!inspected.ok) return inspected
    if (!['completed', 'failed', 'cancelled'].includes(inspected.value.state)) this.cancelled = true
    return this.cancelled
      ? { ok: true, value: this.snapshot('cancelled', error('CANCELLED')) }
      : inspected
  }

  private snapshot(
    state: DeepSeekExecutionSnapshot['state'],
    snapshotError?: DeepSeekExecutionSnapshot['error'],
  ): DeepSeekExecutionSnapshot {
    if (!this.receipt) throw new Error('fixture not dispatched')
    return {
      dispatchId: this.receipt.dispatchId,
      adapterExecutionId: this.receipt.adapterExecutionId,
      taskId: this.receipt.taskId,
      state,
      observedAt: timestamp,
      ...(snapshotError ? { error: snapshotError } : {}),
    }
  }
}

export const createDeepSeekExecutionConformanceRequest = (): ExecutionDispatchRequest => ({
  dispatchId: 'deepseek-conformance-dispatch-1',
  sessionId: 'deepseek-conformance-session-1',
  planId: 'deepseek-conformance-plan-1',
  taskId: 'deepseek-conformance-task-1',
  attempt: 1,
  providerId: 'deepseek',
  task: {
    id: 'deepseek-conformance-task-1',
    title: 'Execute a DeepSeek API task',
    description: 'Run the deterministic DeepSeek adapter fixture.',
    dependsOn: [],
    recommendedProviderId: 'deepseek',
    executionMode: 'api',
    prompt: 'Return a safe text result.',
    files: {
      inputs: [],
      readPaths: [],
      allowedWritePaths: [],
      forbiddenPaths: [],
      outputPaths: [],
    },
    expectedDeliverables: ['Safe structured result'],
    acceptanceChecks: ['Result can be reviewed'],
  },
  directDependencies: [],
})

export const createDeepSeekExecutionAdapterConformanceFixture = (): ExecutionAdapterConformanceFixture => ({
  providerId: 'deepseek',
  executionMode: 'api',
  createAdapter: scenario => new DeepSeekExecutionAdapter(new FakeDeepSeekExecutionClient(scenario)),
  createRequest: createDeepSeekExecutionConformanceRequest,
})
