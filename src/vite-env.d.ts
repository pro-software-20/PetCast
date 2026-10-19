/// <reference types="vite/client" />

interface Window {
  petcast?: {
    beginDrag: () => void
    moveDrag: () => void
    endDrag: () => void
    toggleExpanded: (expanded: boolean) => Promise<void>
    loadGameSave: () => Promise<unknown | null>
    saveGame: (value: unknown) => Promise<void>
    close: () => void
  }
}
