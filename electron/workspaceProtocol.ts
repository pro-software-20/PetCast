export const WORKSPACE_MAX_ENTRIES = 2_000
export const WORKSPACE_MAX_DEPTH = 12

export interface WorkspaceEntry {
  path: string
  kind: 'file' | 'directory'
  size?: number
}

export interface WorkspaceSnapshot {
  schemaVersion: 1
  workspaceId: string
  displayName: string
  entries: WorkspaceEntry[]
  truncated: boolean
  warnings: string[]
}

export type WorkspaceSelectionErrorCode =
  | 'INVALID_REQUEST'
  | 'CANCELLED'
  | 'SCAN_FAILED'
  | 'UNAVAILABLE'

export type WorkspaceSelectionResult =
  | { ok: true; workspace: WorkspaceSnapshot }
  | { ok: false; code: WorkspaceSelectionErrorCode; message: string }

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/

export const isWorkspaceRequestId = (value: unknown): value is string => (
  typeof value === 'string' && REQUEST_ID_PATTERN.test(value)
)
