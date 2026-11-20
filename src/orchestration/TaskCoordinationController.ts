import type {
  TaskCoordinationPolicy,
  TaskCoordinationRecord,
  TaskCoordinationAuditStateV1,
} from '../types/taskCoordination'
import type { TaskSessionV1 } from '../types/taskOrchestration'
import type { TaskCoordinationStore } from './TaskCoordinationStore'
import type { TaskCoordinationAuditStore } from './TaskCoordinationAuditStore'
import {
  appendTaskCoordinationAuditEvent,
  type TaskCoordinationAuditContext,
  type TaskCoordinationAuditEventDraft,
} from './taskCoordinationAudit'
import type { TaskSessionStore } from './TaskSessionStore'
import {
  cancelCoordinatedTask,
  previewTaskCoordinationDispatch,
  runCoordinationCycle,
  type ExecutionAdapterRegistry,
  type TaskCoordinationDispatchPreview,
} from './taskCoordinator'
import {
  reconcileAndSaveTaskSessionWithCoordination,
  type TaskCoordinationNotice,
} from './taskCoordinationSession'
import { resolveTaskCoordination, type TaskRecoveryAction } from './taskCoordinationRecovery'

export type TaskCoordinationControllerStatus =
  | 'idle'
  | 'confirming'
  | 'running'
  | 'paused'
  | 'waiting-user'
  | 'error'
  | 'disposed'

export interface TaskCoordinationControllerSnapshot {
  status: TaskCoordinationControllerStatus
  activeTaskIds: string[]
  records: TaskCoordinationRecord[]
  nextPollAt?: string
  lastCycleAt?: string
  error?: string
  notices: TaskCoordinationNotice[]
  dispatchPreview?: TaskCoordinationDispatchPreview
  confirmationAction?: 'start' | 'resume'
  auditState?: TaskCoordinationAuditStateV1
  auditWarning?: string
}

export interface TaskCoordinationController {
  /**
   * Restores the already-persisted coordination evidence into the paused UI.
   * This is deliberately read-only: reopening the app must never inspect,
   * dispatch, or otherwise resume an external execution by itself.
   */
  hydrate(): Promise<void>
  start(): Promise<void>
  pause(): void
  pauseAndWait(): Promise<void>
  resume(): Promise<void>
  runNow(): Promise<void>
  inspectExisting(): Promise<void>
  cancelTask(taskId: string): Promise<void>
  resolveTask(taskId: string, dispatchId: string, action: TaskRecoveryAction, riskAcknowledged: boolean): Promise<void>
  updateSession(session: TaskSessionV1): void
  clearState(): Promise<void>
  refreshAudit(): Promise<void>
  recordAudit(event: TaskCoordinationAuditEventDraft): Promise<void>
  dispose(): void
  subscribe(listener: (state: TaskCoordinationControllerSnapshot) => void): () => void
}

export interface CreateTaskCoordinationControllerOptions {
  session: TaskSessionV1
  coordinationStore: TaskCoordinationStore
  sessionStore: TaskSessionStore
  adapters: ExecutionAdapterRegistry
  auditStore?: TaskCoordinationAuditStore
  policy?: Partial<TaskCoordinationPolicy>
  onSessionChange?: (session: TaskSessionV1) => void
  now?: () => Date
}

const clone = <T>(value: T): T => structuredClone(value)

const initialStatus = (session: TaskSessionV1): TaskCoordinationControllerStatus => (
  session.plan.tasks.some(task => task.executionMode !== 'manual')
    ? 'paused'
    : 'idle'
)

const activeTaskIds = (records: TaskCoordinationRecord[]) => records
  .filter(record => ['dispatching', 'queued', 'running'].includes(record.phase))
  .map(record => record.taskId)

class DefaultTaskCoordinationController implements TaskCoordinationController {
  private session: TaskSessionV1
  private snapshot: TaskCoordinationControllerSnapshot
  private readonly listeners = new Set<(state: TaskCoordinationControllerSnapshot) => void>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private cycle: Promise<void> | undefined
  private rerunRequested = false
  private confirmed = false
  private generation = 0

  private auditContext(): TaskCoordinationAuditContext {
    return { sessionId: this.session.id, planId: this.session.plan.id, taskIds: this.session.plan.tasks.map(task => task.id) }
  }

  async refreshAudit() {
    if (!this.options.auditStore || this.isDisposed()) return
    const outcome = await this.options.auditStore.load(this.auditContext())
    if (!outcome.ok) {
      this.publish({ auditWarning: outcome.message })
      return
    }
    this.publish({ auditState: outcome.state ?? undefined, auditWarning: undefined })
  }

  async recordAudit(event: TaskCoordinationAuditEventDraft) {
    if (!this.options.auditStore || this.isDisposed()) return
    const context = this.auditContext()
    const loaded = await this.options.auditStore.load(context)
    if (!loaded.ok) {
      this.publish({ auditWarning: loaded.message })
      return
    }
    const appended = appendTaskCoordinationAuditEvent(loaded.state, context, event, this.options.now?.() ?? new Date())
    if (!appended.ok) {
      this.publish({ auditWarning: appended.message })
      return
    }
    const saved = await this.options.auditStore.save(appended.state)
    if (!saved.ok) {
      this.publish({ auditWarning: saved.message })
      return
    }
    this.publish({ auditState: appended.state, auditWarning: undefined })
  }

  constructor(private readonly options: CreateTaskCoordinationControllerOptions) {
    this.session = clone(options.session)
    this.snapshot = {
      status: initialStatus(this.session),
      activeTaskIds: [],
      records: [],
      notices: [],
    }
  }

  subscribe(listener: (state: TaskCoordinationControllerSnapshot) => void) {
    this.listeners.add(listener)
    listener(clone(this.snapshot))
    return () => this.listeners.delete(listener)
  }

  async hydrate() {
    if (this.isDisposed()) return
    const loaded = await this.options.coordinationStore.load({
      sessionId: this.session.id,
      planId: this.session.plan.id,
      taskIds: this.session.plan.tasks.map(task => task.id),
    })
    if (this.isDisposed()) return
    if (!loaded.ok) {
      this.clearTimer()
      this.confirmed = false
      this.publish({
        status: 'paused',
        records: [],
        activeTaskIds: [],
        notices: [],
        nextPollAt: undefined,
        error: loaded.message,
        confirmationAction: undefined,
      })
      return
    }
    const records = loaded.state?.records ?? []
    this.clearTimer()
    this.confirmed = false
    this.publish({
      status: initialStatus(this.session),
      records: clone(records),
      activeTaskIds: activeTaskIds(records),
      notices: [],
      nextPollAt: undefined,
      error: undefined,
      confirmationAction: undefined,
    })
  }

  private publish(patch: Partial<TaskCoordinationControllerSnapshot>) {
    if (this.snapshot.status === 'disposed') return
    const next = { ...this.snapshot, ...patch }
    const preview = previewTaskCoordinationDispatch(
      this.session,
      next.records,
      this.options.adapters,
      this.options.policy,
    )
    this.snapshot = {
      ...next,
      ...(preview.ok ? { dispatchPreview: preview.value } : { dispatchPreview: undefined }),
    }
    const value = clone(this.snapshot)
    this.listeners.forEach(listener => listener(value))
  }

  private clearTimer() {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }

  private isDisposed() {
    return this.snapshot.status === 'disposed'
  }

  private hasConfiguredAutomaticTask() {
    return this.session.plan.tasks.some(task => (
      ['api', 'local-agent'].includes(task.executionMode)
      && Boolean(this.options.adapters.get(
        this.session.runs.find(run => run.taskId === task.id)?.assignedProviderId ?? task.recommendedProviderId,
      ))
    ))
  }

  private async requestConfirmation(action: 'start' | 'resume') {
    const loaded = await this.options.coordinationStore.load({
      sessionId: this.session.id,
      planId: this.session.plan.id,
      taskIds: this.session.plan.tasks.map(task => task.id),
    })
    if (!loaded.ok) {
      this.publish({ status: 'paused', error: loaded.message, confirmationAction: undefined })
      return false
    }
    this.confirmed = false
    this.publish({
      status: 'confirming',
      error: undefined,
      confirmationAction: action,
      records: clone(loaded.state?.records ?? this.snapshot.records),
      activeTaskIds: activeTaskIds(loaded.state?.records ?? this.snapshot.records),
      nextPollAt: undefined,
    })
    await this.recordAudit({
      type: 'confirmation-requested', level: 'info',
      summary: action === 'start' ? '用户正在确认启动自动协调。' : '用户正在确认恢复自动协调。',
    })
    return true
  }

  private schedule(nextPollAt?: string) {
    this.clearTimer()
    if (this.snapshot.status !== 'running' || !nextPollAt) return
    const delay = Math.max(0, Date.parse(nextPollAt) - (this.options.now?.() ?? new Date()).getTime())
    this.timer = setTimeout(() => { void this.runCycle(true) }, delay)
  }

  async start() {
    if (this.snapshot.status === 'disposed') return
    if (!this.hasConfiguredAutomaticTask()) {
      this.publish({
        status: 'waiting-user',
        error: '没有已接入执行适配器的自动任务，人工执行仍可继续使用。',
      })
      return
    }
    if (this.snapshot.status !== 'confirming') {
      await this.requestConfirmation('start')
      return
    }
    const confirmationAction = this.snapshot.confirmationAction
    this.confirmed = true
    this.publish({ status: 'running', error: undefined, confirmationAction: undefined })
    await this.recordAudit({
      type: confirmationAction === 'resume' ? 'coordination-resumed' : 'coordination-started',
      level: 'info',
      summary: confirmationAction === 'resume' ? '用户已确认恢复自动协调。' : '用户已确认启动自动协调。',
    })
    await this.runCycle(true)
  }

  pause() {
    if (this.snapshot.status === 'disposed') return
    this.clearTimer()
    this.confirmed = false
    this.publish({ status: 'paused', nextPollAt: undefined, confirmationAction: undefined })
    void this.recordAudit({ type: 'coordination-paused', level: 'info', summary: '自动协调已暂停；不会继续派发新任务。' })
  }

  async resume() {
    if (this.snapshot.status === 'disposed') return
    if (this.snapshot.status !== 'confirming') {
      await this.requestConfirmation('resume')
      return
    }
    await this.start()
  }

  async runNow() {
    if (this.snapshot.status === 'disposed') return
    await this.runCycle(this.snapshot.status === 'running' && this.confirmed)
  }

  async inspectExisting() {
    if (this.snapshot.status === 'disposed') return
    this.pause()
    await this.recordAudit({ type: 'inspection-requested', level: 'info', summary: '用户请求核对已有外部执行。' })
    if (this.cycle) await this.cycle
    await this.runCycle(false, true)
  }

  private async runCycle(allowDispatch: boolean, inspectTerminal = false) {
    if (this.snapshot.status === 'disposed') return
    if (this.cycle) {
      this.rerunRequested = true
      await this.cycle
      return
    }
    this.clearTimer()
    const generation = this.generation
    const operation = this.performCycle(allowDispatch, generation, inspectTerminal)
    this.cycle = operation
    try {
      await operation
    } finally {
      if (this.cycle === operation) this.cycle = undefined
      if (this.rerunRequested && !this.isDisposed()) {
        this.rerunRequested = false
        void this.runCycle(this.snapshot.status === 'running' && this.confirmed)
      }
    }
  }

  private async performCycle(allowDispatch: boolean, generation: number, inspectTerminal: boolean) {
    const canDispatch = () => (
      allowDispatch
      && this.confirmed
      && this.snapshot.status === 'running'
      && generation === this.generation
    )
    if (canDispatch()) {
      const preview = previewTaskCoordinationDispatch(this.session, this.snapshot.records, this.options.adapters, this.options.policy)
      if (preview.ok) {
        for (const entry of preview.value.dispatchable) {
          await this.recordAudit({
            type: 'dispatch-intended', level: 'info', summary: '协调器准备按已确认队列派发任务。',
            taskId: entry.taskId, providerId: entry.providerId,
          })
        }
      }
    }
    const result = await runCoordinationCycle({
      session: this.session,
      store: this.options.coordinationStore,
      adapters: this.options.adapters,
      policy: this.options.policy,
      now: this.options.now,
      canDispatch,
      inspectTerminal,
    })
    if (generation !== this.generation || this.isDisposed()) return
    if (!result.ok) {
      this.clearTimer()
      this.publish({
        status: result.error.code === 'CORRUPT_STATE' ? 'paused' : 'error',
        error: result.error.message,
        nextPollAt: undefined,
      })
      return
    }

    for (const effect of result.value.effects) {
      const type = effect.type === 'dispatch-accepted' ? 'dispatch-accepted'
        : effect.type === 'execution-running' || effect.type === 'execution-completed'
          || effect.type === 'execution-failed' || effect.type === 'execution-needs-input'
          || effect.type === 'execution-cancelled' || effect.type === 'execution-unknown'
          ? 'execution-snapshot' : 'notice'
      await this.recordAudit({
        type,
        level: effect.type === 'execution-failed' || effect.type === 'execution-unknown' ? 'warning' : 'info',
        summary: effect.type === 'dispatch-accepted' ? '执行适配器已接收派发。' : `执行状态更新为 ${effect.type.replace('execution-', '')}。`,
        taskId: effect.taskId, providerId: effect.providerId, dispatchId: effect.dispatchId, attempt: effect.attempt,
      })
    }

    const reconciled = await reconcileAndSaveTaskSessionWithCoordination({
      session: this.session,
      coordinationState: result.value.state,
      effects: result.value.effects,
      store: this.options.sessionStore,
    })
    if (generation !== this.generation || this.isDisposed()) return
    if (!reconciled.ok) {
      this.clearTimer()
      this.publish({
        status: 'paused',
        error: reconciled.message,
        records: clone(result.value.state.records),
        activeTaskIds: activeTaskIds(result.value.state.records),
        nextPollAt: undefined,
      })
      return
    }
    if (reconciled.changed) {
      this.session = clone(reconciled.session)
      this.options.onSessionChange?.(clone(reconciled.session))
    }
    const stillRunning = this.snapshot.status === 'running'
    const status = stillRunning
      ? (result.value.nextPollAt ? 'running' : 'waiting-user')
      : this.snapshot.status
    this.publish({
      status,
      records: clone(result.value.state.records),
      activeTaskIds: activeTaskIds(result.value.state.records),
      lastCycleAt: (this.options.now?.() ?? new Date()).toISOString(),
      nextPollAt: stillRunning ? result.value.nextPollAt : undefined,
      notices: clone(reconciled.notices),
      error: undefined,
    })
    if (status === 'running') this.schedule(result.value.nextPollAt)
  }

  async cancelTask(taskId: string) {
    if (this.snapshot.status === 'disposed') return
    this.pause()
    // A dispatch already in progress must persist its receipt before cancellation.
    if (this.cycle) await this.cycle
    if (this.isDisposed()) return
    await this.recordAudit({ type: 'execution-cancel-requested', level: 'info', summary: '用户请求取消外部执行。', taskId })
    const result = await cancelCoordinatedTask({
      session: this.session,
      taskId,
      store: this.options.coordinationStore,
      adapters: this.options.adapters,
      now: this.options.now,
    })
    if (!result.ok) {
      this.publish({ status: 'error', error: result.error.message })
      return
    }
    const reconciled = await reconcileAndSaveTaskSessionWithCoordination({
      session: this.session,
      coordinationState: result.value.state,
      effects: result.value.effects,
      store: this.options.sessionStore,
    })
    if (!reconciled.ok) {
      this.publish({ status: 'paused', error: reconciled.message })
      return
    }
    if (reconciled.changed) {
      this.session = clone(reconciled.session)
      this.options.onSessionChange?.(clone(reconciled.session))
    }
    this.publish({
      records: clone(result.value.state.records),
      activeTaskIds: activeTaskIds(result.value.state.records),
      notices: clone(reconciled.notices),
      error: undefined,
    })
    const record = result.value.state.records.find(item => item.taskId === taskId)
    if (record) await this.recordAudit({
      type: 'execution-cancelled', level: 'info', summary: '外部执行已请求取消并完成状态核对。',
      taskId, providerId: record.providerId, dispatchId: record.dispatchId, attempt: record.attempt,
    })
  }

  async pauseAndWait() {
    this.pause()
    if (this.cycle) await this.cycle
  }

  async resolveTask(taskId: string, dispatchId: string, action: TaskRecoveryAction, riskAcknowledged: boolean) {
    if (this.isDisposed()) return
    this.pause()
    if (this.cycle) await this.cycle
    // Inspect durable references first. This pass cannot dispatch new work.
    await this.inspectExisting()
    if (this.isDisposed() || this.snapshot.error) return
    const checkedRecord = this.snapshot.records.find(record => record.dispatchId === dispatchId)
    if (checkedRecord?.phase === 'completed') {
      this.publish({ notices: [{ taskId, dispatchId, level: 'info', code: 'MANUAL_REVIEW_REQUIRED',
        message: '已查到旧执行的完成结果，任务转入待验收；未创建新尝试。' }] })
      return
    }
    const outcome = await resolveTaskCoordination({
      session: this.session,
      taskId,
      dispatchId,
      action,
      riskAcknowledged,
      coordinationStore: this.options.coordinationStore,
      sessionStore: this.options.sessionStore,
      now: this.options.now,
    })
    if (!outcome.ok) {
      this.publish({ status: 'paused', error: outcome.message })
      return
    }
    if (outcome.changed) {
      this.session = clone(outcome.session)
      this.options.onSessionChange?.(clone(outcome.session))
    }
    await this.recordAudit({
      type: 'recovery-decision', level: action === 'new-attempt' ? 'warning' : 'info',
      summary: action === 'manual-takeover' ? '用户确认转为人工处理。' : '用户确认旧执行不会继续，并允许创建新的尝试。',
      taskId, dispatchId,
    })
    this.publish({
      status: 'paused',
      records: clone(outcome.state.records),
      activeTaskIds: activeTaskIds(outcome.state.records),
      error: undefined,
      notices: [{
        taskId,
        dispatchId,
        level: 'info',
        code: 'MANUAL_REVIEW_REQUIRED',
        message: action === 'manual-takeover'
          ? '已转为人工处理，可录入结果。'
          : '已保存新尝试决定；请重新启动协调，系统不会自动重派。',
      }],
    })
  }

  updateSession(session: TaskSessionV1) {
    if (this.snapshot.status === 'disposed') return
    const changedSession = session.id !== this.session.id || session.plan.id !== this.session.plan.id
    const changedContent = JSON.stringify(session) !== JSON.stringify(this.session)
    if (!changedContent) return
    this.generation += 1
    this.clearTimer()
    this.session = clone(session)
    if (changedSession) {
      this.confirmed = false
      this.publish({
        status: initialStatus(session),
        activeTaskIds: [],
        records: [],
        notices: [],
        nextPollAt: undefined,
        lastCycleAt: undefined,
        error: undefined,
        confirmationAction: undefined,
        auditState: undefined,
        auditWarning: undefined,
      })
      return
    }
    if (this.confirmed && ['running', 'waiting-user'].includes(this.snapshot.status)) {
      this.publish({ status: 'running' })
      void this.runCycle(true)
    }
  }

  async clearState() {
    this.pause()
    if (this.cycle) await this.cycle
    const existing = await this.options.coordinationStore.load({
      sessionId: this.session.id,
      planId: this.session.plan.id,
      taskIds: this.session.plan.tasks.map(task => task.id),
    })
    if (existing.ok && existing.state?.records.length) {
      this.publish({ status: 'paused', error: '协调记录包含执行证据，不能清除；请逐项核对或人工处理。' })
      return
    }
    if (!existing.ok) {
      this.publish({ status: 'paused', error: existing.message })
      return
    }
    const cleared = await this.options.coordinationStore.clear()
    if (!cleared.ok) {
      this.publish({ status: 'paused', error: cleared.message })
      return
    }
    this.confirmed = false
    this.publish({
      status: 'idle',
      activeTaskIds: [],
      records: [],
      notices: [],
      nextPollAt: undefined,
      lastCycleAt: undefined,
      error: undefined,
      confirmationAction: undefined,
    })
  }

  dispose() {
    if (this.snapshot.status === 'disposed') return
    this.generation += 1
    this.clearTimer()
    this.snapshot = { ...this.snapshot, status: 'disposed', nextPollAt: undefined }
    this.listeners.clear()
  }
}

export const createTaskCoordinationController = (
  options: CreateTaskCoordinationControllerOptions,
): TaskCoordinationController => new DefaultTaskCoordinationController(options)

export const createIdleTaskCoordinationSnapshot = (): TaskCoordinationControllerSnapshot => ({
  status: 'idle',
  activeTaskIds: [],
  records: [],
  notices: [],
})
