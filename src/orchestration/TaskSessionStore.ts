import { MAX_TASK_SESSION_BYTES, validateTaskSession } from './taskSessionValidation'
import type { TaskSessionV1 } from '../types/taskOrchestration'

export const TASK_SESSION_STORAGE_KEY = 'petcast.task-session.v1'

export type TaskSessionStoreErrorCode =
  | 'CORRUPT_DATA'
  | 'LIMIT_EXCEEDED'
  | 'STORAGE_UNAVAILABLE'

export type TaskSessionLoadOutcome =
  | { ok: true; session: TaskSessionV1 | null }
  | { ok: false; code: TaskSessionStoreErrorCode; message: string }

export type TaskSessionWriteOutcome =
  | { ok: true }
  | { ok: false; code: TaskSessionStoreErrorCode; message: string }

export interface TaskSessionStore {
  loadLatest(): Promise<TaskSessionLoadOutcome>
  save(session: TaskSessionV1): Promise<TaskSessionWriteOutcome>
  clear(): Promise<TaskSessionWriteOutcome>
}

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const unavailable = (): TaskSessionWriteOutcome => ({
  ok: false,
  code: 'STORAGE_UNAVAILABLE',
  message: '本地任务存储不可用，本次进度可能无法在重启后恢复。',
})

export class LocalTaskSessionStore implements TaskSessionStore {
  constructor(private readonly storage?: StorageLike) {}

  private getStorage(): StorageLike {
    if (this.storage) return this.storage
    return window.localStorage
  }

  async loadLatest(): Promise<TaskSessionLoadOutcome> {
    let raw: string | null
    try {
      raw = this.getStorage().getItem(TASK_SESSION_STORAGE_KEY)
    } catch {
      return { ok: false, code: 'STORAGE_UNAVAILABLE', message: '本地任务存储不可用，无法恢复进度。' }
    }
    if (!raw) return { ok: true, session: null }
    if (new TextEncoder().encode(raw).length > MAX_TASK_SESSION_BYTES) {
      return { ok: false, code: 'LIMIT_EXCEEDED', message: '本地任务记录超过大小限制，未自动载入。' }
    }
    try {
      const validation = validateTaskSession(JSON.parse(raw))
      return validation.ok
        ? { ok: true, session: validation.session }
        : { ok: false, code: 'CORRUPT_DATA', message: '本地任务记录损坏或版本不兼容，未自动覆盖原数据。' }
    } catch {
      return { ok: false, code: 'CORRUPT_DATA', message: '本地任务记录无法解析，未自动覆盖原数据。' }
    }
  }

  async save(session: TaskSessionV1): Promise<TaskSessionWriteOutcome> {
    const validation = validateTaskSession(session)
    if (!validation.ok) {
      return validation.issues.some(issue => issue.code === 'LIMIT_EXCEEDED')
        ? { ok: false, code: 'LIMIT_EXCEEDED', message: '任务会话超过本地存储大小限制。' }
        : { ok: false, code: 'CORRUPT_DATA', message: '任务会话未通过校验，未写入本地存储。' }
    }
    const raw = JSON.stringify(session)
    if (new TextEncoder().encode(raw).length > MAX_TASK_SESSION_BYTES) {
      return { ok: false, code: 'LIMIT_EXCEEDED', message: '任务会话超过 2 MiB，无法继续保存。' }
    }
    try {
      this.getStorage().setItem(TASK_SESSION_STORAGE_KEY, raw)
      return { ok: true }
    } catch {
      return unavailable()
    }
  }

  async clear(): Promise<TaskSessionWriteOutcome> {
    try {
      this.getStorage().removeItem(TASK_SESSION_STORAGE_KEY)
      return { ok: true }
    } catch {
      return unavailable()
    }
  }
}
