import type {
  DeepSeekExecutionError,
  DeepSeekExecutionSnapshot as ClientSnapshot,
} from '../../electron/deepSeekExecutionProtocol'
import type {
  ExecutionAdapter,
  ExecutionAdapterError,
  ExecutionAdapterOutcome,
  ExecutionDispatchRequest,
  ExecutionReceipt,
  ExecutionReference,
  ExecutionSnapshot,
} from '../types/taskCoordination'
import {
  validateExecutionDispatchRequest,
  validateExecutionReference,
  validateExecutionSnapshot,
} from './taskCoordinationValidation'
import type { DeepSeekExecutionClient } from './deepSeekExecutionClient'

const safeMessages: Record<ExecutionAdapterError['code'], string> = {
  INVALID_INPUT: 'DeepSeek 执行请求无效。',
  UNAVAILABLE: 'DeepSeek 执行服务暂时不可用。',
  UNSUPPORTED_MODE: 'DeepSeek 适配器不支持当前执行模式。',
  TIMEOUT: 'DeepSeek 执行超时。',
  RATE_LIMITED: 'DeepSeek 请求受到速率限制。',
  NEEDS_INPUT: 'DeepSeek 执行需要补充输入。',
  CANCELLED: 'DeepSeek 执行已取消。',
  EXECUTION_NOT_FOUND: '未找到匹配的 DeepSeek 执行记录。',
  INVALID_RESPONSE: 'DeepSeek 返回了无法安全处理的结果。',
  FAILED: 'DeepSeek 未能完成任务。',
}

const safeError = (error: DeepSeekExecutionError): ExecutionAdapterError => ({
  code: error.code,
  retryable: error.retryable,
  message: safeMessages[error.code],
  ...(error.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: error.retryAfterSeconds }),
})
const localError = (
  code: ExecutionAdapterError['code'],
  retryable = false,
): ExecutionAdapterError => ({ code, retryable, message: safeMessages[code] })
const failed = <T>(error: ExecutionAdapterError): ExecutionAdapterOutcome<T> => ({ ok: false, error })

const toReference = (reference: ExecutionReference) => ({
  dispatchId: reference.dispatchId,
  adapterExecutionId: reference.adapterExecutionId,
  taskId: reference.taskId,
})

const toSnapshot = (value: ClientSnapshot): ExecutionSnapshot => ({
  dispatchId: value.dispatchId,
  adapterExecutionId: value.adapterExecutionId,
  taskId: value.taskId,
  state: value.state,
  observedAt: value.observedAt,
  ...(value.result ? {
    result: {
      taskId: value.taskId,
      providerId: 'deepseek',
      summary: value.result.summary,
      outputText: value.result.outputText,
      changedFiles: [],
      verification: structuredClone(value.result.verification),
      ...(value.result.usage ? { usage: structuredClone(value.result.usage) } : {}),
    },
  } : {}),
  ...(value.error ? { error: safeError(value.error) } : {}),
})

export class DeepSeekExecutionAdapter implements ExecutionAdapter {
  constructor(private readonly client: DeepSeekExecutionClient) {}

  async dispatch(
    request: ExecutionDispatchRequest,
    signal?: AbortSignal,
  ): Promise<ExecutionAdapterOutcome<ExecutionReceipt>> {
    if (signal?.aborted) return failed(localError('CANCELLED'))
    if (!validateExecutionDispatchRequest(request).ok) return failed(localError('INVALID_INPUT'))
    if (request.providerId !== 'deepseek') return failed(localError('INVALID_INPUT'))
    if (request.task.executionMode !== 'api') return failed(localError('UNSUPPORTED_MODE'))
    const outcome = await this.client.dispatch({
      dispatchId: request.dispatchId,
      taskId: request.taskId,
      title: request.task.title,
      description: request.task.description,
      prompt: request.task.prompt,
      dependencySummaries: request.directDependencies.map(dependency => (
        dependency.summary.length > 500 ? `${dependency.summary.slice(0, 499)}…` : dependency.summary
      )),
      acceptanceChecks: structuredClone(request.task.acceptanceChecks),
    }, signal)
    if (!outcome.ok) return failed(safeError(outcome.error))
    const receipt: ExecutionReceipt = {
      dispatchId: outcome.value.dispatchId,
      adapterExecutionId: outcome.value.adapterExecutionId,
      taskId: outcome.value.taskId,
      state: outcome.value.state,
      acceptedAt: outcome.value.acceptedAt,
    }
    return receipt.dispatchId === request.dispatchId && receipt.taskId === request.taskId
      ? { ok: true, value: receipt }
      : failed(localError('INVALID_RESPONSE'))
  }

  async inspect(
    reference: ExecutionReference,
    signal?: AbortSignal,
  ): Promise<ExecutionAdapterOutcome<ExecutionSnapshot>> {
    if (signal?.aborted) return failed(localError('CANCELLED'))
    if (!validateExecutionReference(reference).ok) return failed(localError('INVALID_INPUT'))
    const outcome = await this.client.inspect(toReference(reference), signal)
    if (!outcome.ok) return failed(safeError(outcome.error))
    const snapshot = toSnapshot(outcome.value)
    const checked = validateExecutionSnapshot(snapshot, {
      dispatchId: reference.dispatchId,
      taskId: reference.taskId,
      providerId: 'deepseek',
    })
    return checked.ok && snapshot.adapterExecutionId === reference.adapterExecutionId
      ? { ok: true, value: checked.value }
      : failed(localError('INVALID_RESPONSE'))
  }

  async cancel(
    reference: ExecutionReference,
    signal?: AbortSignal,
  ): Promise<ExecutionAdapterOutcome<ExecutionSnapshot>> {
    if (signal?.aborted) return failed(localError('CANCELLED'))
    if (!validateExecutionReference(reference).ok) return failed(localError('INVALID_INPUT'))
    const outcome = await this.client.cancel(toReference(reference), signal)
    if (!outcome.ok) return failed(safeError(outcome.error))
    const snapshot = toSnapshot(outcome.value)
    const checked = validateExecutionSnapshot(snapshot, {
      dispatchId: reference.dispatchId,
      taskId: reference.taskId,
      providerId: 'deepseek',
    })
    return checked.ok && snapshot.adapterExecutionId === reference.adapterExecutionId
      ? { ok: true, value: checked.value }
      : failed(localError('INVALID_RESPONSE'))
  }
}
