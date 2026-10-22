/// <reference types="vite/client" />

interface Window {
  petcast?: import('./history/UsageHistoryStore').HistoryBridge & import('./history/TaskLedger').TaskLedgerBridge & {
    readCodexUsage: (requestId: string) => Promise<import('../electron/codexProtocol').CodexQuotaResult>
    cancelCodexUsage: (requestId: string) => void
    beginDrag: () => void
    moveDrag: () => void
    endDrag: () => void
    toggleExpanded: (expanded: boolean) => Promise<void>
    loadGameSave: () => Promise<unknown | null>
    saveGame: (value: unknown) => Promise<void>
    close: () => void
  }
}
