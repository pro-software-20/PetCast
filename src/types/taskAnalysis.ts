export type TaskComplexity = 'low' | 'medium' | 'high'

/** Metadata only: size is bytes, type is MIME. No file content is read by this contract. */
export interface TaskAnalysisFile {
  name: string
  type: string
  size: number
}

export interface TokenRange {
  min: number
  max: number
}

export type PromptOptimizationSource = 'deepseek' | 'local'

export interface TaskAnalysisInput {
  prompt: string
  files: TaskAnalysisFile[]
}

export interface TaskAnalysisResult {
  taskType: string
  complexity: TaskComplexity
  estimatedInputTokens: TokenRange
  estimatedOutputTokens: TokenRange
  estimationBasis: 'heuristic-metadata'
  assumptions: string[]
  optimizedPrompt: string
  promptOptimizationSource: PromptOptimizationSource
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
