import type { TaskAcceptanceStateV1 } from '../types/taskCoordination'
import {
  MAX_TASK_ACCEPTANCE_BYTES,
  type TaskAcceptanceStateContext,
  validateTaskAcceptanceState,
} from './taskEvaluationValidation'

export const TASK_ACCEPTANCE_STORAGE_KEY = 'petcast.task-acceptance.v1'

export type TaskAcceptanceStoreErrorCode =
  | 'CORRUPT_DATA'
  | 'LIMIT_EXCEEDED'
  | 'STORAGE_UNAVAILABLE'

export type TaskAcceptanceLoadOutcome =
  | { ok: true; state: TaskAcceptanceStateV1 | null }
  | { ok: false; code: TaskAcceptanceStoreErrorCode; message: string }

export type TaskAcceptanceWriteOutcome =
  | { ok: true }
  | { ok: false; code: TaskAcceptanceStoreErrorCode; message: string }

export interface TaskAcceptanceStore {
  load(context: TaskAcceptanceStateContext): Promise<TaskAcceptanceLoadOutcome>
  save(state: TaskAcceptanceStateV1): Promise<TaskAcceptanceWriteOutcome>
  clear(): Promise<TaskAcceptanceWriteOutcome>
}

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const clone = <T>(value: T): T => structuredClone(value)

const validateForWrite = (state: TaskAcceptanceStateV1): TaskAcceptanceWriteOutcome => {
  const checked = validateTaskAcceptanceState(state)
  if (checked.ok) return { ok: true }
  return checked.issues.some(item => item.code === 'LIMIT_EXCEEDED')
    ? { ok: false, code: 'LIMIT_EXCEEDED', message: '任务验收状态超过本地存储限制。' }
    : { ok: false, code: 'CORRUPT_DATA', message: '任务验收状态未通过严格校验。' }
}

export class LocalTaskAcceptanceStore implements TaskAcceptanceStore {
  constructor(private readonly storage?: StorageLike) {}

  private getStorage(): StorageLike {
    if (this.storage) return this.storage
    return window.localStorage
  }

  async load(context: TaskAcceptanceStateContext): Promise<TaskAcceptanceLoadOutcome> {
    let raw: string | null
    try {
      raw = this.getStorage().getItem(TASK_ACCEPTANCE_STORAGE_KEY)
    } catch {
      return { ok: false, code: 'STORAGE_UNAVAILABLE', message: '本地任务验收存储不可用。' }
    }
    if (!raw) return { ok: true, state: null }
    if (new TextEncoder().encode(raw).length > MAX_TASK_ACCEPTANCE_BYTES) {
      return { ok: false, code: 'LIMIT_EXCEEDED', message: '本地任务验收记录超过 2 MiB，未自动载入。' }
    }
    try {
      const checked = validateTaskAcceptanceState(JSON.parse(raw), context)
      return checked.ok
        ? { ok: true, state: clone(checked.value) }
        : { ok: false, code: 'CORRUPT_DATA', message: '本地任务验收记录损坏或与当前会话不匹配。' }
    } catch {
      return { ok: false, code: 'CORRUPT_DATA', message: '本地任务验收记录无法解析，原数据未被覆盖。' }
    }
  }

  async save(state: TaskAcceptanceStateV1): Promise<TaskAcceptanceWriteOutcome> {
    const valid = validateForWrite(state)
    if (!valid.ok) return valid
    const raw = JSON.stringify(state)
    if (new TextEncoder().encode(raw).length > MAX_TASK_ACCEPTANCE_BYTES) {
      return { ok: false, code: 'LIMIT_EXCEEDED', message: '任务验收状态超过 2 MiB，无法保存。' }
    }
    try {
      this.getStorage().setItem(TASK_ACCEPTANCE_STORAGE_KEY, raw)
      return { ok: true }
    } catch {
      return { ok: false, code: 'STORAGE_UNAVAILABLE', message: '任务验收状态保存失败。' }
    }
  }

  async clear(): Promise<TaskAcceptanceWriteOutcome> {
    try {
      this.getStorage().removeItem(TASK_ACCEPTANCE_STORAGE_KEY)
      return { ok: true }
    } catch {
      return { ok: false, code: 'STORAGE_UNAVAILABLE', message: '任务验收状态无法清除。' }
    }
  }
}

export class MemoryTaskAcceptanceStore implements TaskAcceptanceStore {
  private state: TaskAcceptanceStateV1 | null
  readonly writes: TaskAcceptanceStateV1[] = []

  constructor(initialState: TaskAcceptanceStateV1 | null = null) {
    this.state = initialState ? clone(initialState) : null
  }

  async load(context: TaskAcceptanceStateContext): Promise<TaskAcceptanceLoadOutcome> {
    if (!this.state) return { ok: true, state: null }
    const checked = validateTaskAcceptanceState(this.state, context)
    return checked.ok
      ? { ok: true, state: clone(checked.value) }
      : { ok: false, code: 'CORRUPT_DATA', message: '内存验收状态损坏或与当前会话不匹配。' }
  }

  async save(state: TaskAcceptanceStateV1): Promise<TaskAcceptanceWriteOutcome> {
    const valid = validateForWrite(state)
    if (!valid.ok) return valid
    this.state = clone(state)
    this.writes.push(clone(state))
    return { ok: true }
  }

  async clear(): Promise<TaskAcceptanceWriteOutcome> {
    this.state = null
    return { ok: true }
  }

  peek(): TaskAcceptanceStateV1 | null {
    return this.state ? clone(this.state) : null
  }
}
