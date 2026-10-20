export type TaskComplexity = 'low' | 'medium' | 'high'

export interface TaskAnalysisFile {
  name: string
  type: string
  size: number
}

export interface TokenRange {
  min: number
  max: number
}

export interface TaskAnalysisInput {
  prompt: string
  files: TaskAnalysisFile[]
}

export interface TaskAnalysisResult {
  taskType: string
  complexity: TaskComplexity
  estimatedInputTokens: TokenRange
  estimatedOutputTokens: TokenRange
  optimizedPrompt: string
  canRunInParallel: boolean
  parallelPlan: string[]
  warnings: string[]
}
