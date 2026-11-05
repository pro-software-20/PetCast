import type {
  ProviderId,
  TaskHandoffArtifact,
  TaskNode,
  TaskVerificationResult,
  TaskExecutionResult,
} from './taskOrchestration'

export const EXECUTION_ADAPTER_STATES = [
  'queued',
  'running',
  'needs-input',
  'completed',
  'failed',
  'cancelled',
  'unknown',
] as const
export type ExecutionAdapterState = (typeof EXECUTION_ADAPTER_STATES)[number]

export const EXECUTION_ADAPTER_ERROR_CODES = [
  'INVALID_INPUT',
  'UNAVAILABLE',
  'UNSUPPORTED_MODE',
  'TIMEOUT',
  'RATE_LIMITED',
  'NEEDS_INPUT',
  'CANCELLED',
  'EXECUTION_NOT_FOUND',
  'INVALID_RESPONSE',
  'FAILED',
] as const
export type ExecutionAdapterErrorCode = (typeof EXECUTION_ADAPTER_ERROR_CODES)[number]

export interface ExecutionAdapterError {
  code: ExecutionAdapterErrorCode
  retryable: boolean
  message: string
  retryAfterSeconds?: number
}

/**
 * A dependency handoff is deliberately smaller than TaskExecutionResult.
 * It never contains the previous provider's complete output.
 */
export interface ExecutionDependencyHandoff {
  dependencyTaskId: string
  summary: string
  keyDecisions: string[]
  verification: TaskVerificationResult[]
  artifacts: TaskHandoffArtifact[]
  openQuestions: string[]
}

/** B -> A request. dispatchId is the idempotency key for a paid execution. */
export interface ExecutionDispatchRequest {
  dispatchId: string
  sessionId: string
  planId: string
  taskId: string
  attempt: number
  providerId: ProviderId
  task: TaskNode
  directDependencies: ExecutionDependencyHandoff[]
}

export interface ExecutionReference {
  dispatchId: string
  adapterExecutionId: string
  taskId: string
}

export interface ExecutionReceipt extends ExecutionReference {
  state: ExecutionAdapterState
  acceptedAt: string
}

export interface ExecutionSnapshot extends ExecutionReference {
  state: ExecutionAdapterState
  observedAt: string
  result?: TaskExecutionResult
  error?: ExecutionAdapterError
}

export type ExecutionAdapterOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: ExecutionAdapterError }

export interface ExecutionAdapter {
  dispatch(
    request: ExecutionDispatchRequest,
    signal?: AbortSignal,
  ): Promise<ExecutionAdapterOutcome<ExecutionReceipt>>
  inspect(
    reference: ExecutionReference,
    signal?: AbortSignal,
  ): Promise<ExecutionAdapterOutcome<ExecutionSnapshot>>
  cancel(
    reference: ExecutionReference,
    signal?: AbortSignal,
  ): Promise<ExecutionAdapterOutcome<ExecutionSnapshot>>
}

export const EVALUATION_VERDICTS = ['accepted', 'revise', 'unknown'] as const
export type EvaluationVerdict = (typeof EVALUATION_VERDICTS)[number]

export const EVALUATION_METHODS = ['user', 'rubric', 'automated'] as const
export type EvaluationMethod = (typeof EVALUATION_METHODS)[number]

export const EVALUATION_EVIDENCE_TYPES = [
  'test-log',
  'diff',
  'artifact',
  'user-review',
  'metric',
  'other',
] as const
export type EvaluationEvidenceType = (typeof EVALUATION_EVIDENCE_TYPES)[number]

/** D -> B evidence reference. reference is opaque and must not be an absolute path. */
export interface EvaluationEvidenceRef {
  type: EvaluationEvidenceType
  reference: string
  summary: string
}

export interface EvaluationReport {
  evaluationId: string
  dispatchId: string
  taskId: string
  verdict: EvaluationVerdict
  verification: TaskVerificationResult[]
  method: EvaluationMethod
  ruleVersion: string
  comparisonBasis: string
  evidence: EvaluationEvidenceRef[]
  note: string
  createdAt: string
}

export type AcceptancePolicyMode = 'manual' | 'trusted-evaluation'

export interface AcceptancePolicy {
  mode: AcceptancePolicyMode
  trustedMethods: EvaluationMethod[]
  maxAttempts: number
}

export const ACCEPTANCE_DECISION_ACTIONS = [
  'complete',
  'request-changes',
  'retry',
  'needs-input',
  'manual-review',
  'fail',
] as const
export type AcceptanceDecisionAction = (typeof ACCEPTANCE_DECISION_ACTIONS)[number]

export const ACCEPTANCE_DECISION_REASONS = [
  'MANUAL_POLICY',
  'UNTRUSTED_METHOD',
  'ACCEPTED_AND_VERIFIED',
  'ACCEPTED_WITH_INCOMPLETE_CHECKS',
  'REVISION_REQUESTED',
  'MAX_ATTEMPTS_REACHED',
  'EVALUATION_UNKNOWN',
] as const
export type AcceptanceDecisionReason = (typeof ACCEPTANCE_DECISION_REASONS)[number]

export interface AcceptanceDecision {
  evaluationId: string
  taskId: string
  dispatchId: string
  action: AcceptanceDecisionAction
  reason: AcceptanceDecisionReason
  requiresHumanConfirmation: boolean
}

