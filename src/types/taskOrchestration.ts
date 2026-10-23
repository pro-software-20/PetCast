import type { TaskAnalysisFile, TaskAnalysisInput, TaskAnalysisResult } from './taskAnalysis'

export const BUILT_IN_PROVIDER_IDS = ['local', 'codex', 'deepseek', 'doubao'] as const
export type BuiltInProviderId = (typeof BUILT_IN_PROVIDER_IDS)[number]
export type CustomProviderId = `custom:${string}`
export type ProviderId = BuiltInProviderId | CustomProviderId

export const EXECUTION_MODES = ['manual', 'api', 'local-agent'] as const
export type ExecutionMode = (typeof EXECUTION_MODES)[number]

export const PROVIDER_CAPABILITIES = [
  'planning',
  'text-generation',
  'research',
  'coding',
  'file-editing',
  'testing',
  'vision',
] as const
export type ProviderCapability = (typeof PROVIDER_CAPABILITIES)[number]

export const TASK_WORK_CATEGORIES = [
  'planning',
  'coding',
  'testing',
  'research',
  'analysis',
  'writing',
  'review',
  'vision',
  'general',
] as const
export type TaskWorkCategory = (typeof TASK_WORK_CATEGORIES)[number]

export const RECOMMENDATION_CONFIDENCES = ['high', 'medium', 'low'] as const
export type RecommendationConfidence = (typeof RECOMMENDATION_CONFIDENCES)[number]

export interface TaskProviderRecommendation {
  category: TaskWorkCategory
  requiredCapabilities: ProviderCapability[]
  confidence: RecommendationConfidence
  reason: string
}

export type QuotaSupport = 'official-api' | 'local-record' | 'manual' | 'none'

/** Public provider metadata only. Credentials never belong in this contract. */
export interface ProviderProfile {
  id: ProviderId
  displayName: string
  capabilities: ProviderCapability[]
  executionModes: ExecutionMode[]
  quotaSupport: QuotaSupport
}

/** A browser-selected attachment. This deliberately contains metadata only. */
export interface AttachmentFileReference extends TaskAnalysisFile {
  kind: 'attachment'
}

/** A project file identified relative to the active workspace root. */
export interface WorkspaceFileReference {
  kind: 'workspace'
  path: string
}

export type TaskInputFileReference = AttachmentFileReference | WorkspaceFileReference

export interface TaskFileScope {
  inputs: TaskInputFileReference[]
  /** Exact files or directory prefixes relative to the workspace root. */
  allowedWritePaths: string[]
  forbiddenPaths: string[]
  outputPaths: string[]
}

/** Static task definition. Runtime state is kept in TaskRunRecord. */
export interface TaskNode {
  id: string
  title: string
  description: string
  dependsOn: string[]
  recommendedProviderId: ProviderId
  /** Optional so task sessions created before P2.2 remain restorable. */
  providerRecommendation?: TaskProviderRecommendation
  executionMode: ExecutionMode
  prompt: string
  files: TaskFileScope
  expectedDeliverables: string[]
  acceptanceChecks: string[]
}

export interface TaskPlan {
  schemaVersion: 1
  id: string
  title: string
  goal: string
  assumptions: string[]
  tasks: TaskNode[]
  finalAcceptanceChecks: string[]
}

export const TASK_STATUSES = [
  'waiting',
  'ready',
  'running',
  'needs-input',
  'review',
  'done',
  'failed',
  'cancelled',
] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

export type VerificationStatus = 'passed' | 'failed' | 'not-run'

export interface TaskVerificationResult {
  label: string
  status: VerificationStatus
  details?: string
}

export interface TaskTokenUsage {
  inputTokens?: number
  outputTokens?: number
}

export interface TaskCost {
  amount: number
  currency: string
}

export interface TaskExecutionResult {
  taskId: string
  providerId: ProviderId
  summary: string
  outputText?: string
  changedFiles: string[]
  verification: TaskVerificationResult[]
  reviewNote?: string
  usage?: TaskTokenUsage
  cost?: TaskCost
}

export interface TaskResultDraft {
  outputText: string
  changedFiles: string[]
  verification: TaskVerificationResult[]
  reviewNote: string
}

/** Mutable execution state kept separately from the AI-generated task plan. */
export interface TaskRunRecord {
  taskId: string
  status: TaskStatus
  assignedProviderId: ProviderId
  executionMode: ExecutionMode
  attempt: number
  draft: TaskResultDraft
  statusMessage?: string
  startedAt?: string
  completedAt?: string
  result?: TaskExecutionResult
}

export interface TaskSessionV1 {
  schemaVersion: 1
  id: string
  createdAt: string
  updatedAt: string
  completedAt?: string
  analysisInput: TaskAnalysisInput
  analysisResult: TaskAnalysisResult
  plan: TaskPlan
  runs: TaskRunRecord[]
  finalVerification: TaskVerificationResult[]
}
