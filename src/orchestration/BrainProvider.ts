import type { TaskAnalysisInput, TaskAnalysisResult } from '../types/taskAnalysis'
import type {
  BrainPlanningErrorCode,
  ProviderProfile,
  TaskBrainProfile,
  TaskPlan,
} from '../types/taskOrchestration'

export type { BrainPlanningErrorCode } from '../types/taskOrchestration'

export interface BrainPlanningInput {
  analysisInput: TaskAnalysisInput
  analysisResult: TaskAnalysisResult
  availableProviders: ProviderProfile[]
}

export type BrainPlanningOutcome =
  | { ok: true; plan: TaskPlan }
  | { ok: false; code: BrainPlanningErrorCode; message: string }

export interface BrainProvider {
  readonly profile: TaskBrainProfile
  createPlan(input: BrainPlanningInput, signal?: AbortSignal): Promise<BrainPlanningOutcome>
}
