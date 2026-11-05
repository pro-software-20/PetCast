import type {
  ExecutionAdapterError,
  ExecutionDispatchRequest,
} from '../types/taskCoordination'
import type { TaskExecutionResult } from '../types/taskOrchestration'
import type { WorkerExecutionErrorCode, WorkerProvider } from './WorkerProvider'
import { InMemoryExecutionAdapter } from './executionAdapterFixtures'

const workerErrorMap: Record<WorkerExecutionErrorCode, ExecutionAdapterError['code']> = {
  INVALID_INPUT: 'INVALID_INPUT',
  UNAVAILABLE: 'UNAVAILABLE',
  UNSUPPORTED_MODE: 'UNSUPPORTED_MODE',
  TIMEOUT: 'TIMEOUT',
  CANCELLED: 'CANCELLED',
  FAILED: 'FAILED',
}

const toLegacyDependencyResult = (
  dependency: ExecutionDispatchRequest['directDependencies'][number],
): TaskExecutionResult => ({
  taskId: dependency.dependencyTaskId,
  providerId: 'local',
  summary: dependency.summary,
  changedFiles: dependency.artifacts.map(artifact => artifact.path),
  verification: dependency.verification,
  handoff: {
    summary: dependency.summary,
    keyDecisions: dependency.keyDecisions,
    artifacts: dependency.artifacts,
    openQuestions: dependency.openQuestions,
  },
})

/**
 * Compatibility bridge for the pre-P3 one-shot WorkerProvider contract.
 * It is process-local and therefore must only inspect, never redispatch, after recovery.
 */
export class WorkerProviderExecutionAdapter extends InMemoryExecutionAdapter {
  constructor(worker: WorkerProvider) {
    super(async (request, signal) => {
      if (request.providerId !== worker.profile.id) {
        return {
          ok: false,
          error: {
            code: 'INVALID_INPUT',
            retryable: false,
            message: '派发 Provider 与旧 WorkerProvider 不匹配。',
          },
        }
      }
      const outcome = await worker.execute({
        planId: request.planId,
        task: request.task,
        dependencyResults: request.directDependencies.map(toLegacyDependencyResult),
      }, signal)
      return outcome.ok
        ? { ok: true, value: outcome.result }
        : {
            ok: false,
            error: {
              code: workerErrorMap[outcome.code],
              retryable: ['UNAVAILABLE', 'TIMEOUT', 'FAILED'].includes(outcome.code),
              message: '旧执行适配器返回了安全封装后的错误。',
            },
          }
    })
  }
}
