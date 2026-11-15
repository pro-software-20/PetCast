import type { TaskCoordinationAuditStateV1 } from '../types/taskCoordination'
import {
  MAX_TASK_COORDINATION_AUDIT_BYTES,
  type TaskCoordinationAuditContext,
  validateTaskCoordinationAuditState,
} from './taskCoordinationAudit'

export const TASK_COORDINATION_AUDIT_STORAGE_KEY = 'petcast.task-coordination-audit.v1'

export type TaskCoordinationAuditStoreErrorCode = 'CORRUPT_DATA' | 'LIMIT_EXCEEDED' | 'STORAGE_UNAVAILABLE'
export type TaskCoordinationAuditLoadOutcome =
  | { ok: true; state: TaskCoordinationAuditStateV1 | null }
  | { ok: false; code: TaskCoordinationAuditStoreErrorCode; message: string }
export type TaskCoordinationAuditWriteOutcome =
  | { ok: true }
  | { ok: false; code: TaskCoordinationAuditStoreErrorCode; message: string }

export interface TaskCoordinationAuditStore {
  load(context: TaskCoordinationAuditContext): Promise<TaskCoordinationAuditLoadOutcome>
  save(state: TaskCoordinationAuditStateV1): Promise<TaskCoordinationAuditWriteOutcome>
  clear(): Promise<TaskCoordinationAuditWriteOutcome>
}

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const invalid = (state: TaskCoordinationAuditStateV1): TaskCoordinationAuditWriteOutcome => {
  const checked = validateTaskCoordinationAuditState(state)
  if (checked.ok) return { ok: true }
  return checked.issues.some(issue => issue.code === 'LIMIT_EXCEEDED')
    ? { ok: false, code: 'LIMIT_EXCEEDED', message: '协调审计记录超过本地容量限制。' }
    : { ok: false, code: 'CORRUPT_DATA', message: '协调审计记录未通过严格校验。' }
}

export class LocalTaskCoordinationAuditStore implements TaskCoordinationAuditStore {
  constructor(private readonly storage?: StorageLike) {}
  private getStorage(): StorageLike { return this.storage ?? window.localStorage }

  async load(context: TaskCoordinationAuditContext): Promise<TaskCoordinationAuditLoadOutcome> {
    let raw: string | null
    try { raw = this.getStorage().getItem(TASK_COORDINATION_AUDIT_STORAGE_KEY) } catch {
      return { ok: false, code: 'STORAGE_UNAVAILABLE', message: '协调审计存储不可用。' }
    }
    if (!raw) return { ok: true, state: null }
    if (new TextEncoder().encode(raw).length > MAX_TASK_COORDINATION_AUDIT_BYTES) {
      return { ok: false, code: 'LIMIT_EXCEEDED', message: '协调审计记录超过容量限制，未自动覆盖。' }
    }
    try {
      const value = JSON.parse(raw)
      // This store deliberately keeps only the current session. A valid record
      // for an earlier session is therefore stale rather than corrupt; keep it
      // untouched until the new session writes its first audit event.
      const structural = validateTaskCoordinationAuditState(value)
      if (structural.ok && structural.value
        && (structural.value.sessionId !== context.sessionId || structural.value.planId !== context.planId)) {
        return { ok: true, state: null }
      }
      const checked = validateTaskCoordinationAuditState(value, context)
      return checked.ok && checked.value
        ? { ok: true, state: checked.value }
        : { ok: false, code: 'CORRUPT_DATA', message: '协调审计记录损坏或不属于当前会话，原数据未删除。' }
    } catch {
      return { ok: false, code: 'CORRUPT_DATA', message: '协调审计记录无法解析，原数据未删除。' }
    }
  }

  async save(state: TaskCoordinationAuditStateV1): Promise<TaskCoordinationAuditWriteOutcome> {
    const valid = invalid(state)
    if (!valid.ok) return valid
    try { this.getStorage().setItem(TASK_COORDINATION_AUDIT_STORAGE_KEY, JSON.stringify(state)); return { ok: true } } catch {
      return { ok: false, code: 'STORAGE_UNAVAILABLE', message: '协调审计记录保存失败。' }
    }
  }

  async clear(): Promise<TaskCoordinationAuditWriteOutcome> {
    try { this.getStorage().removeItem(TASK_COORDINATION_AUDIT_STORAGE_KEY); return { ok: true } } catch {
      return { ok: false, code: 'STORAGE_UNAVAILABLE', message: '协调审计记录无法清除。' }
    }
  }
}

export class MemoryTaskCoordinationAuditStore implements TaskCoordinationAuditStore {
  private state: TaskCoordinationAuditStateV1 | null
  readonly writes: TaskCoordinationAuditStateV1[] = []
  constructor(initial: TaskCoordinationAuditStateV1 | null = null) { this.state = initial ? clone(initial) : null }
  async load(context: TaskCoordinationAuditContext): Promise<TaskCoordinationAuditLoadOutcome> {
    if (!this.state) return { ok: true, state: null }
    const structural = validateTaskCoordinationAuditState(this.state)
    if (structural.ok && structural.value
      && (structural.value.sessionId !== context.sessionId || structural.value.planId !== context.planId)) {
      return { ok: true, state: null }
    }
    const checked = validateTaskCoordinationAuditState(this.state, context)
    return checked.ok && checked.value
      ? { ok: true, state: clone(checked.value) }
      : { ok: false, code: 'CORRUPT_DATA', message: '内存协调审计记录损坏或不匹配。' }
  }
  async save(state: TaskCoordinationAuditStateV1): Promise<TaskCoordinationAuditWriteOutcome> {
    const valid = invalid(state)
    if (!valid.ok) return valid
    this.state = clone(state); this.writes.push(clone(state)); return { ok: true }
  }
  async clear(): Promise<TaskCoordinationAuditWriteOutcome> { this.state = null; return { ok: true } }
  peek(): TaskCoordinationAuditStateV1 | null { return this.state ? clone(this.state) : null }
}
