import type {
  ProviderProfile,
  TaskExecutionResult,
  TaskNode,
} from '../types/taskOrchestration'

export interface TaskExecutionRequest {
  planId: string
  task: TaskNode
  dependencyResults: TaskExecutionResult[]
}

export type WorkerExecutionErrorCode =
  | 'INVALID_INPUT'
  | 'UNAVAILABLE'
  | 'UNSUPPORTED_MODE'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'FAILED'

export type WorkerExecutionOutcome =
  | { ok: true; result: TaskExecutionResult }
  | { ok: false; code: WorkerExecutionErrorCode; message: string }

export interface WorkerProvider {
  readonly profile: ProviderProfile
  execute(request: TaskExecutionRequest, signal?: AbortSignal): Promise<WorkerExecutionOutcome>
}
