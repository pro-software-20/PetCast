import type { TaskCoordinationStateV1 } from '../types/taskCoordination'
import {
  MAX_TASK_COORDINATION_BYTES,
  type TaskCoordinationStateContext,
  validateTaskCoordinationState,
} from './taskCoordinationStateValidation'

export const TASK_COORDINATION_STORAGE_KEY = 'petcast.task-coordination.v1'

export type TaskCoordinationStoreErrorCode =
  | 'CORRUPT_DATA'
  | 'LIMIT_EXCEEDED'
  | 'STORAGE_UNAVAILABLE'

export type TaskCoordinationLoadOutcome =
  | { ok: true; state: TaskCoordinationStateV1 | null }
  | { ok: false; code: TaskCoordinationStoreErrorCode; message: string }

export type TaskCoordinationWriteOutcome =
  | { ok: true }
  | { ok: false; code: TaskCoordinationStoreErrorCode; message: string }

export interface TaskCoordinationStore {
  load(context: TaskCoordinationStateContext): Promise<TaskCoordinationLoadOutcome>
  save(state: TaskCoordinationStateV1): Promise<TaskCoordinationWriteOutcome>
  clear(): Promise<TaskCoordinationWriteOutcome>
}

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const validateForWrite = (state: TaskCoordinationStateV1): TaskCoordinationWriteOutcome => {
  const checked = validateTaskCoordinationState(state)
  if (!checked.ok) {
    return checked.issues.some(item => item.code === 'LIMIT_EXCEEDED')
      ? { ok: false, code: 'LIMIT_EXCEEDED', message: '任务协调状态超过本地存储限制。' }
      : { ok: false, code: 'CORRUPT_DATA', message: '任务协调状态未通过严格校验。' }
  }
  return { ok: true }
}

export class LocalTaskCoordinationStore implements TaskCoordinationStore {
  constructor(private readonly storage?: StorageLike) {}

  private getStorage(): StorageLike {
    if (this.storage) return this.storage
    return window.localStorage
  }

  async load(context: TaskCoordinationStateContext): Promise<TaskCoordinationLoadOutcome> {
    let raw: string | null
    try {
      raw = this.getStorage().getItem(TASK_COORDINATION_STORAGE_KEY)
    } catch {
      return { ok: false, code: 'STORAGE_UNAVAILABLE', message: '本地任务协调存储不可用。' }
    }
    if (!raw) return { ok: true, state: null }
    if (new TextEncoder().encode(raw).length > MAX_TASK_COORDINATION_BYTES) {
      return { ok: false, code: 'LIMIT_EXCEEDED', message: '本地任务协调记录超过 2 MiB，未自动载入。' }
    }
    try {
      const checked = validateTaskCoordinationState(JSON.parse(raw), context)
      return checked.ok
        ? { ok: true, state: checked.value }
        : { ok: false, code: 'CORRUPT_DATA', message: '本地任务协调记录损坏或与当前会话不匹配。' }
    } catch {
      return { ok: false, code: 'CORRUPT_DATA', message: '本地任务协调记录无法解析，原数据未被覆盖。' }
    }
  }

  async save(state: TaskCoordinationStateV1): Promise<TaskCoordinationWriteOutcome> {
    const valid = validateForWrite(state)
    if (!valid.ok) return valid
    const raw = JSON.stringify(state)
    if (new TextEncoder().encode(raw).length > MAX_TASK_COORDINATION_BYTES) {
      return { ok: false, code: 'LIMIT_EXCEEDED', message: '任务协调状态超过 2 MiB，无法保存。' }
    }
    try {
      this.getStorage().setItem(TASK_COORDINATION_STORAGE_KEY, raw)
      return { ok: true }
    } catch {
      return { ok: false, code: 'STORAGE_UNAVAILABLE', message: '任务协调状态保存失败。' }
    }
  }

  async clear(): Promise<TaskCoordinationWriteOutcome> {
    try {
      this.getStorage().removeItem(TASK_COORDINATION_STORAGE_KEY)
      return { ok: true }
    } catch {
      return { ok: false, code: 'STORAGE_UNAVAILABLE', message: '任务协调状态无法清除。' }
    }
  }
}

export class MemoryTaskCoordinationStore implements TaskCoordinationStore {
  private state: TaskCoordinationStateV1 | null
  readonly writes: TaskCoordinationStateV1[] = []

  constructor(initialState: TaskCoordinationStateV1 | null = null) {
    this.state = initialState ? clone(initialState) : null
  }

  async load(context: TaskCoordinationStateContext): Promise<TaskCoordinationLoadOutcome> {
    if (!this.state) return { ok: true, state: null }
    const checked = validateTaskCoordinationState(this.state, context)
    return checked.ok
      ? { ok: true, state: clone(checked.value) }
      : { ok: false, code: 'CORRUPT_DATA', message: '内存协调状态损坏或与当前会话不匹配。' }
  }

  async save(state: TaskCoordinationStateV1): Promise<TaskCoordinationWriteOutcome> {
    const valid = validateForWrite(state)
    if (!valid.ok) return valid
    this.state = clone(state)
    this.writes.push(clone(state))
    return { ok: true }
  }

  async clear(): Promise<TaskCoordinationWriteOutcome> {
    this.state = null
    return { ok: true }
  }

  peek(): TaskCoordinationStateV1 | null {
    return this.state ? clone(this.state) : null
  }
}
