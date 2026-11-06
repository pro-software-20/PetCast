import type {
  TaskCoordinationPolicy,
  TaskCoordinationRecord,
} from '../types/taskCoordination'
import type { TaskSessionV1 } from '../types/taskOrchestration'
import type { TaskCoordinationStore } from './TaskCoordinationStore'
import type { TaskSessionStore } from './TaskSessionStore'
import {
  cancelCoordinatedTask,
  runCoordinationCycle,
  type ExecutionAdapterRegistry,
} from './taskCoordinator'
import {
  reconcileAndSaveTaskSessionWithCoordination,
  type TaskCoordinationNotice,
} from './taskCoordinationSession'

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
}

export interface TaskCoordinationController {
  start(): Promise<void>
  pause(): void
  resume(): Promise<void>
  runNow(): Promise<void>
  cancelTask(taskId: string): Promise<void>
  updateSession(session: TaskSessionV1): void
  clearState(): Promise<void>
  dispose(): void
  subscribe(listener: (state: TaskCoordinationControllerSnapshot) => void): () => void
}

export interface CreateTaskCoordinationControllerOptions {
  session: TaskSessionV1
  coordinationStore: TaskCoordinationStore
  sessionStore: TaskSessionStore
  adapters: ExecutionAdapterRegistry
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

  private publish(patch: Partial<TaskCoordinationControllerSnapshot>) {
    if (this.snapshot.status === 'disposed') return
    this.snapshot = { ...this.snapshot, ...patch }
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
    if (!this.confirmed) {
      if (this.snapshot.status !== 'confirming') {
        this.publish({ status: 'confirming', error: undefined })
        return
      }
      this.confirmed = true
    }
    this.publish({ status: 'running', error: undefined })
    await this.runCycle(true)
  }

  pause() {
    if (this.snapshot.status === 'disposed') return
    this.clearTimer()
    this.publish({ status: 'paused', nextPollAt: undefined })
  }

  async resume() {
    if (this.snapshot.status === 'disposed') return
    if (!this.confirmed) {
      this.publish({ status: 'confirming', error: undefined })
      return
    }
    this.publish({ status: 'running', error: undefined })
    // The scheduler always inspects persisted references before considering a
    // new dispatch, so resume is inspect-first by construction.
    await this.runCycle(true)
  }

  async runNow() {
    if (this.snapshot.status === 'disposed') return
    await this.runCycle(this.snapshot.status === 'running' && this.confirmed)
  }

  private async runCycle(allowDispatch: boolean) {
    if (this.snapshot.status === 'disposed') return
    if (this.cycle) {
      this.rerunRequested = true
      await this.cycle
      return
    }
    this.clearTimer()
    const generation = this.generation
    const operation = this.performCycle(allowDispatch, generation)
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

  private async performCycle(allowDispatch: boolean, generation: number) {
    const canDispatch = () => (
      allowDispatch
      && this.confirmed
      && this.snapshot.status === 'running'
      && generation === this.generation
    )
    const result = await runCoordinationCycle({
      session: this.session,
      store: this.options.coordinationStore,
      adapters: this.options.adapters,
      policy: this.options.policy,
      now: this.options.now,
      canDispatch,
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
