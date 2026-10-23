import type { TaskAnalysisInput, TaskAnalysisResult } from '../types/taskAnalysis'
import type { ProviderProfile, TaskPlan } from '../types/taskOrchestration'

export interface BrainPlanningInput {
  analysisInput: TaskAnalysisInput
  analysisResult: TaskAnalysisResult
  availableProviders: ProviderProfile[]
}

export type BrainPlanningErrorCode =
  | 'INVALID_INPUT'
  | 'UNAVAILABLE'
  | 'TIMEOUT'
  | 'INVALID_RESPONSE'
  | 'CANCELLED'
  | 'FAILED'

export type BrainPlanningOutcome =
  | { ok: true; plan: TaskPlan }
  | { ok: false; code: BrainPlanningErrorCode; message: string }

export interface BrainProvider {
  readonly profile: ProviderProfile
  createPlan(input: BrainPlanningInput, signal?: AbortSignal): Promise<BrainPlanningOutcome>
}
