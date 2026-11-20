/// <reference types="vite/client" />

interface Window {
  petcast?: import('./history/UsageHistoryStore').HistoryBridge & import('./history/TaskLedger').TaskLedgerBridge & {
    readCodexUsage: (requestId: string) => Promise<import('../electron/codexProtocol').CodexQuotaResult>
    cancelCodexUsage: (requestId: string) => void
    checkCodexEnvironment: (
      requestId: string,
    ) => Promise<import('../electron/codexEnvironmentProtocol').CodexEnvironmentResult>
    cancelCodexEnvironment: (requestId: string) => void
    readChatGptSession: () => Promise<import('../electron/chatGptAuthProtocol').ChatGptSessionResult>
    signInWithChatGpt: (
      requestId: string,
    ) => Promise<import('../electron/chatGptAuthProtocol').ChatGptSessionResult>
    cancelChatGptSignIn: (requestId: string) => void
    signOutChatGpt: () => Promise<import('../electron/chatGptAuthProtocol').ChatGptSessionResult>
    openChatGptUsage: () => Promise<boolean>
    optimizeTaskPrompt: (
      input: import('../electron/promptOptimizationProtocol').PromptOptimizationRequest,
    ) => Promise<import('../electron/promptOptimizationProtocol').PromptOptimizationResult>
    planTaskWithDeepSeek: (
      input: import('../electron/taskPlanningProtocol').TaskPlanningIpcRequest,
    ) => Promise<import('../electron/taskPlanningProtocol').TaskPlanningServiceResult>
    cancelDeepSeekTaskPlan: (requestId: string) => void
    readDeepSeekConnection: () => Promise<{ configured: boolean; model: string }>
    connectCodexQueue: () => Promise<{ configured: boolean; message: string }>
    readCodexQueueStatus: () => Promise<{ configured: boolean }>
    readCodexActivity: () => Promise<Array<{ id: string; kind: 'planning' | 'execution' | 'connection'; taskId?: string; message: string; active: boolean; updatedAt: string }>>
    planTaskWithCodex: (input: import('../electron/taskPlanningProtocol').TaskPlanningIpcRequest) => Promise<import('../electron/taskPlanningProtocol').TaskPlanningServiceResult>
    cancelCodexTaskPlan: (id: string) => void
    dispatchCodexQueue: (input: import('../electron/deepSeekExecutionProtocol').DeepSeekExecutionDispatchInput) => Promise<import('../electron/deepSeekExecutionProtocol').DeepSeekExecutionOutcome<import('../electron/deepSeekExecutionProtocol').DeepSeekExecutionReceipt>>
    inspectCodexQueue: (input: import('../electron/deepSeekExecutionProtocol').DeepSeekExecutionReferenceInput) => Promise<import('../electron/deepSeekExecutionProtocol').DeepSeekExecutionOutcome<import('../electron/deepSeekExecutionProtocol').DeepSeekExecutionSnapshot>>
    cancelCodexQueue: (input: import('../electron/deepSeekExecutionProtocol').DeepSeekExecutionReferenceInput) => Promise<import('../electron/deepSeekExecutionProtocol').DeepSeekExecutionOutcome<import('../electron/deepSeekExecutionProtocol').DeepSeekExecutionSnapshot>>
    configureDeepSeekConnection: (input: { apiKey: string; model: string }) => Promise<{ ok: boolean; message: string }>
    dispatchDeepSeekExecution: (
      input: import('../electron/deepSeekExecutionProtocol').DeepSeekExecutionDispatchInput,
    ) => Promise<import('../electron/deepSeekExecutionProtocol').DeepSeekExecutionOutcome<import('../electron/deepSeekExecutionProtocol').DeepSeekExecutionReceipt>>
    inspectDeepSeekExecution: (
      input: import('../electron/deepSeekExecutionProtocol').DeepSeekExecutionReferenceInput,
    ) => Promise<import('../electron/deepSeekExecutionProtocol').DeepSeekExecutionOutcome<import('../electron/deepSeekExecutionProtocol').DeepSeekExecutionSnapshot>>
    cancelDeepSeekExecution: (
      input: import('../electron/deepSeekExecutionProtocol').DeepSeekExecutionReferenceInput,
    ) => Promise<import('../electron/deepSeekExecutionProtocol').DeepSeekExecutionOutcome<import('../electron/deepSeekExecutionProtocol').DeepSeekExecutionSnapshot>>
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
    beginResize: (corner: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right') => void
    resizeWindow: () => void
    endResize: () => void
    toggleExpanded: (expanded: boolean) => Promise<void>
    loadGameSave: () => Promise<unknown | null>
    saveGame: (value: unknown) => Promise<void>
    readCustomPet: () => Promise<import('../electron/customPetProtocol').CustomPetResult>
    saveCustomPet: (bytes: Uint8Array) => Promise<import('../electron/customPetProtocol').CustomPetResult>
    deleteCustomPet: () => Promise<import('../electron/customPetProtocol').CustomPetResult>
    close: () => void
  }
}
