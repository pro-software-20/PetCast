import type { TaskAnalysisInput, TaskAnalysisResult } from '../types/taskAnalysis'

export interface TaskAnalyzer {
  analyze(input: TaskAnalysisInput): Promise<TaskAnalysisResult>
}
