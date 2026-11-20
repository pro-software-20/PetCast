import { DeepSeekExecutionAdapter } from './DeepSeekExecutionAdapter'
import type { DeepSeekExecutionClient } from './deepSeekExecutionClient'
import type { ExecutionAdapter, ExecutionDispatchRequest, ExecutionReference, ExecutionSnapshot, ExecutionAdapterOutcome } from '../types/taskCoordination'
import { validateExecutionDispatchRequest } from './taskCoordinationValidation'

/** Both runners use the same durable text-execution transport, with distinct provider identities. */
export class CodexQueueAdapter implements ExecutionAdapter {
  private delegate: DeepSeekExecutionAdapter
  constructor(client: DeepSeekExecutionClient) { this.delegate = new DeepSeekExecutionAdapter(client) }
  async dispatch(request: ExecutionDispatchRequest, signal?: AbortSignal) {
    if (!validateExecutionDispatchRequest(request).ok) return { ok: false as const, error: { code: 'INVALID_INPUT' as const, retryable: false, message: 'Codex 执行请求无效。' } }
    const files = request.task.files
    if (!validateExecutionDispatchRequest(request).ok || request.providerId !== 'codex' || request.task.executionMode !== 'local-agent'
      || files.inputs.length || files.readPaths?.length || files.allowedWritePaths.length || files.outputPaths.length) {
      return { ok: false as const, error: { code: 'UNSUPPORTED_MODE' as const, retryable: false, message: '统一 Codex 队列目前只接收文本任务。项目文件修改请使用原 Codex 隔离执行入口。' } }
    }
    const result = await this.delegate.dispatch({ ...request, providerId: 'deepseek', task: { ...request.task, executionMode: 'api' } }, signal)
    return result.ok ? result : { ...result, error: { ...result.error, message: result.error.message.replaceAll('DeepSeek', 'Codex') } }
  }
  private map(result: ExecutionAdapterOutcome<ExecutionSnapshot>): ExecutionAdapterOutcome<ExecutionSnapshot> {
    return result.ok ? { ok: true, value: { ...result.value, ...(result.value.error ? { error: { ...result.value.error, message: result.value.error.message.replaceAll('DeepSeek', 'Codex') } } : {}), ...(result.value.result ? { result: { ...result.value.result, providerId: 'codex' } } : {}) } }
      : { ...result, error: { ...result.error, message: result.error.message.replaceAll('DeepSeek', 'Codex') } }
  }
  async inspect(reference: ExecutionReference, signal?: AbortSignal) { return this.map(await this.delegate.inspect(reference, signal)) }
  async cancel(reference: ExecutionReference, signal?: AbortSignal) { return this.map(await this.delegate.cancel(reference, signal)) }
}
