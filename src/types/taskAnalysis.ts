export interface TaskAnalysisInput {
  prompt: string
  /** Metadata only: size is bytes, type is MIME. No file content is read by this contract. */
  files: Array<{ name: string; type: string; size: number }>
}

export interface TaskAnalysisResult {
  taskType: string
  complexity: 'low' | 'medium' | 'high'
  estimatedInputTokens: { min: number; max: number }
  estimatedOutputTokens: { min: number; max: number }
  estimationBasis: 'heuristic-metadata'
  assumptions: string[]
  optimizedPrompt: string
  canRunInParallel: boolean
  /** Display-only advice, never an executable task graph. */
  parallelPlan: string[]
  warnings: string[]
}

export type TaskAnalysisOutcome =
  | { ok: true; result: TaskAnalysisResult }
  | { ok: false; code: 'EMPTY_INPUT' | 'INPUT_TOO_LARGE' | 'INVALID_FILE' | 'ANALYSIS_FAILED'; message: string }

export interface TaskAnalyzer {
  analyze(input: TaskAnalysisInput): Promise<TaskAnalysisOutcome>
}
