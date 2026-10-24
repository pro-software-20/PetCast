/// <reference types="vite/client" />

interface Window {
  petcast?: import('./history/UsageHistoryStore').HistoryBridge & import('./history/TaskLedger').TaskLedgerBridge & {
    readCodexUsage: (requestId: string) => Promise<import('../electron/codexProtocol').CodexQuotaResult>
    cancelCodexUsage: (requestId: string) => void
    optimizeTaskPrompt: (
      input: import('../electron/promptOptimizationProtocol').PromptOptimizationRequest,
    ) => Promise<import('../electron/promptOptimizationProtocol').PromptOptimizationResult>
    selectTaskWorkspace: (
      requestId: string,
    ) => Promise<import('../electron/workspaceProtocol').WorkspaceSelectionResult>
    cancelTaskWorkspace: (requestId: string) => void
    prepareCodexTaskExecution: (
      input: import('../electron/taskExecutionProtocol').PrepareCodexTaskExecutionRequest,
    ) => Promise<import('../electron/taskExecutionProtocol').TaskExecutionOutcome<import('../electron/taskExecutionProtocol').PreparedCodexTaskExecution>>
    runCodexTaskExecution: (
      executionId: string,
    ) => Promise<import('../electron/taskExecutionProtocol').TaskExecutionOutcome<import('../electron/taskExecutionProtocol').CodexTaskExecutionResult>>
    cancelCodexTaskExecution: (executionId: string) => void
    readTaskExecutionArtifact: (
      artifactId: string,
    ) => Promise<import('../electron/taskExecutionProtocol').TaskExecutionOutcome<import('../electron/taskExecutionProtocol').TaskExecutionArtifactView>>
    applyTaskExecutionArtifact: (artifactId: string) => Promise<import('../electron/taskExecutionProtocol').TaskExecutionOutcome<null>>
    discardTaskExecutionArtifact: (artifactId: string) => Promise<import('../electron/taskExecutionProtocol').TaskExecutionOutcome<null>>
    onTaskExecutionEvent: (
      listener: (event: import('../electron/taskExecutionProtocol').TaskExecutionEvent) => void,
    ) => () => void
    beginDrag: () => void
    moveDrag: () => void
    endDrag: () => void
    toggleExpanded: (expanded: boolean) => Promise<void>
    loadGameSave: () => Promise<unknown | null>
    saveGame: (value: unknown) => Promise<void>
    close: () => void
  }
}
