import type {
  ExecutionAdapter,
  ExecutionAdapterError,
  ExecutionDispatchRequest,
  ExecutionReceipt,
  ExecutionReference,
  ExecutionSnapshot,
  TaskCoordinationEffect,
  TaskCoordinationEffectType,
  TaskCoordinationPolicy,
  TaskCoordinationRecord,
  TaskCoordinationStateV1,
} from '../types/taskCoordination'
import type {
  ProviderId,
  TaskNode,
  TaskSessionV1,
} from '../types/taskOrchestration'
import type { TaskCoordinationStore } from './TaskCoordinationStore'
import {
  validateExecutionDispatchRequest,
  validateExecutionReceipt,
  validateExecutionSnapshot,
} from './taskCoordinationValidation'
import { orderTasksForDispatch } from './taskScheduling'
import { getHandoffReadiness } from './taskHandoff'
import { validateTaskSession } from './taskSessionValidation'

export const DEFAULT_TASK_COORDINATION_POLICY: TaskCoordinationPolicy = {
  globalConcurrency: 2,
  providerConcurrency: 1,
  pollIntervalMs: 2_000,
}

export interface ExecutionAdapterRegistry {
  get(providerId: ProviderId): ExecutionAdapter | undefined
}

export class MapExecutionAdapterRegistry implements ExecutionAdapterRegistry {
  private readonly adapters: Map<ProviderId, ExecutionAdapter>

  constructor(entries: Iterable<readonly [ProviderId, ExecutionAdapter]> = []) {
    this.adapters = new Map(entries)
  }

  get(providerId: ProviderId) {
    return this.adapters.get(providerId)
  }
}

export type TaskCoordinatorErrorCode =
  | 'INVALID_INPUT'
  | 'CORRUPT_STATE'
  | 'STORAGE_UNAVAILABLE'
  | 'CANCELLED'
  | 'EXECUTION_NOT_FOUND'
  | 'FAILED'

export interface TaskCoordinatorError {
  code: TaskCoordinatorErrorCode
  message: string
}

export interface TaskCoordinationCycleResult {
  state: TaskCoordinationStateV1
  effects: TaskCoordinationEffect[]
  nextPollAt?: string
}

export type TaskCoordinatorOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: TaskCoordinatorError }

export interface RunTaskCoordinationCycleInput {
  session: TaskSessionV1
  store: TaskCoordinationStore
  adapters: ExecutionAdapterRegistry
  policy?: Partial<TaskCoordinationPolicy>
  signal?: AbortSignal
  now?: () => Date
  canDispatch?: () => boolean
  /** Explicit recovery check may re-query a terminal failure before a human decides. */
  inspectTerminal?: boolean
}

export interface CancelCoordinatedTaskInput {
  session: TaskSessionV1
  taskId: string
  store: TaskCoordinationStore
  adapters: ExecutionAdapterRegistry
  signal?: AbortSignal
  now?: () => Date
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const safeAdapterError = (
  code: ExecutionAdapterError['code'],
  message: string,
  retryable = false,
  retryAfterSeconds?: number,
): ExecutionAdapterError => ({
  code,
  retryable,
  message,
  ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
})

const schedulerError = <T>(code: TaskCoordinatorErrorCode, message: string): TaskCoordinatorOutcome<T> => ({
  ok: false,
  error: { code, message },
})

const hash32 = (value: string, seed: number) => {
  let hash = seed >>> 0
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

export function createStableDispatchId(
  sessionId: string,
  planId: string,
  taskId: string,
  attempt: number,
  providerId: ProviderId,
) {
  const source = [sessionId, planId, taskId, String(attempt), providerId].join('\0')
  return `dispatch-${hash32(source, 0x811c9dc5)}${hash32(source, 0x9e3779b1)}`
}

const resolvePolicy = (
  value: Partial<TaskCoordinationPolicy> | undefined,
): TaskCoordinatorOutcome<TaskCoordinationPolicy> => {
  const policy = { ...DEFAULT_TASK_COORDINATION_POLICY, ...value }
  if (!Number.isInteger(policy.globalConcurrency) || policy.globalConcurrency < 1
    || !Number.isInteger(policy.providerConcurrency) || policy.providerConcurrency < 1
    || !Number.isInteger(policy.pollIntervalMs) || policy.pollIntervalMs < 100) {
    return schedulerError('INVALID_INPUT', '调度并发数和轮询间隔必须是有效正整数。')
  }
  return { ok: true, value: policy }
}

const stateEffectType = (state: ExecutionSnapshot['state']): TaskCoordinationEffectType | null => {
  switch (state) {
    case 'running': return 'execution-running'
    case 'needs-input': return 'execution-needs-input'
    case 'completed': return 'execution-completed'
    case 'failed': return 'execution-failed'
    case 'cancelled': return 'execution-cancelled'
    case 'unknown': return 'execution-unknown'
    default: return null
  }
}

const makeEffect = (
  type: TaskCoordinationEffectType,
  record: TaskCoordinationRecord,
  occurredAt: string,
  options: {
    reference?: ExecutionReference
    snapshot?: ExecutionSnapshot
    error?: ExecutionAdapterError
  } = {},
): TaskCoordinationEffect => ({
  type,
  taskId: record.taskId,
  providerId: record.providerId,
  attempt: record.attempt,
  dispatchId: record.dispatchId,
  occurredAt,
  ...(options.reference ? { reference: clone(options.reference) } : {}),
  ...(options.snapshot ? { snapshot: clone(options.snapshot) } : {}),
  ...(options.error ? { error: clone(options.error) } : {}),
})

const createState = (session: TaskSessionV1, now: string): TaskCoordinationStateV1 => ({
  schemaVersion: 1,
  sessionId: session.id,
  planId: session.plan.id,
  updatedAt: now,
  records: [],
})

const saveState = async (
  store: TaskCoordinationStore,
  state: TaskCoordinationStateV1,
  now: string,
): Promise<TaskCoordinatorOutcome<TaskCoordinationStateV1>> => {
  state.updatedAt = now
  const saved = await store.save(state)
  if (!saved.ok) {
    return schedulerError(
      saved.code === 'STORAGE_UNAVAILABLE' ? 'STORAGE_UNAVAILABLE' : 'CORRUPT_STATE',
      saved.message,
    )
  }
  return { ok: true, value: state }
}

const directDependencyHandoffs = (
  session: TaskSessionV1,
  task: TaskNode,
): ExecutionDispatchRequest['directDependencies'] | null => {
  const handoffs: ExecutionDispatchRequest['directDependencies'] = []
  for (const dependencyTaskId of task.dependsOn) {
    const run = session.runs.find(candidate => candidate.taskId === dependencyTaskId)
    if (!run || run.status !== 'done' || !run.result) return null
    const handoff = run.result.handoff
    handoffs.push({
      dependencyTaskId,
      summary: handoff?.summary || run.result.summary,
      keyDecisions: [...(handoff?.keyDecisions ?? [])],
      verification: clone(run.result.verification),
      artifacts: clone(handoff?.artifacts ?? []),
      openQuestions: [...(handoff?.openQuestions ?? [])],
    })
  }
  return handoffs
}

const referenceFromReceipt = (receipt: ExecutionReceipt): ExecutionReference => ({
  dispatchId: receipt.dispatchId,
  adapterExecutionId: receipt.adapterExecutionId,
  taskId: receipt.taskId,
})

const applySnapshot = (
  record: TaskCoordinationRecord,
  snapshot: ExecutionSnapshot,
  effects: TaskCoordinationEffect[],
) => {
  record.phase = snapshot.state
  record.latestSnapshot = clone(snapshot)
  record.error = snapshot.error ? clone(snapshot.error) : undefined
  record.updatedAt = snapshot.observedAt
  const type = stateEffectType(snapshot.state)
  if (type) {
    effects.push(makeEffect(type, record, snapshot.observedAt, {
      reference: record.reference,
      snapshot,
      error: snapshot.error,
    }))
  }
}

const failurePhase = (error: ExecutionAdapterError): TaskCoordinationRecord['phase'] => {
  if (error.code === 'NEEDS_INPUT') return 'needs-input'
  if (error.code === 'CANCELLED') return 'cancelled'
  if (['INVALID_INPUT', 'UNSUPPORTED_MODE', 'INVALID_RESPONSE'].includes(error.code)) return 'failed'
  return 'unknown'
}

const failureEffect = (phase: TaskCoordinationRecord['phase']): TaskCoordinationEffectType => {
  if (phase === 'needs-input') return 'execution-needs-input'
  if (phase === 'cancelled') return 'execution-cancelled'
  if (phase === 'failed') return 'execution-failed'
  return 'execution-unknown'
}

const setRecordFailure = (
  record: TaskCoordinationRecord,
  error: ExecutionAdapterError,
  at: string,
  effects: TaskCoordinationEffect[],
) => {
  record.phase = failurePhase(error)
  record.latestSnapshot = undefined
  record.error = clone(error)
  record.updatedAt = at
  effects.push(makeEffect(failureEffect(record.phase), record, at, {
    reference: record.reference,
    error,
  }))
}

const validateSession = (session: TaskSessionV1): TaskCoordinatorOutcome<TaskSessionV1> => {
  const checked = validateTaskSession(session)
  return checked.ok
    ? { ok: true, value: checked.session }
    : schedulerError('INVALID_INPUT', '任务会话未通过严格校验，无法调度。')
}

const aborted = (signal?: AbortSignal) => signal?.aborted === true

export async function runCoordinationCycle(
  input: RunTaskCoordinationCycleInput,
): Promise<TaskCoordinatorOutcome<TaskCoordinationCycleResult>> {
  const sessionResult = validateSession(input.session)
  if (!sessionResult.ok) return sessionResult
  const policyResult = resolvePolicy(input.policy)
  if (!policyResult.ok) return policyResult
  if (aborted(input.signal)) return schedulerError('CANCELLED', '任务协调周期已取消。')

  const now = input.now ?? (() => new Date())
  const cycleTime = now().toISOString()
  const session = sessionResult.value
  const loaded = await input.store.load({
    sessionId: session.id,
    planId: session.plan.id,
    taskIds: session.plan.tasks.map(task => task.id),
  })
  if (!loaded.ok) {
    return schedulerError(
      loaded.code === 'STORAGE_UNAVAILABLE' ? 'STORAGE_UNAVAILABLE' : 'CORRUPT_STATE',
      loaded.message,
    )
  }
  const state = loaded.state ? clone(loaded.state) : createState(session, cycleTime)
  const effects: TaskCoordinationEffect[] = []

  // A persisted intent without a receipt is an uncertain paid call. Never replay it.
  for (const record of state.records) {
    if (!record.resolution && record.phase === 'dispatching' && !record.reference) {
      setRecordFailure(
        record,
        safeAdapterError('FAILED', '应用在收到执行收据前中断，需要人工核对，禁止自动重派。'),
        cycleTime,
        effects,
      )
    }
  }

  for (const record of state.records) {
    if (aborted(input.signal)) return schedulerError('CANCELLED', '任务协调周期已取消。')
    const shouldInspect = !record.resolution && record.reference && (
      ['queued', 'running', 'needs-input', 'unknown'].includes(record.phase)
      || (input.inspectTerminal && ['failed', 'cancelled'].includes(record.phase))
      || (record.phase === 'completed' && !record.latestSnapshot)
    )
    if (!shouldInspect || !record.reference) continue
    const adapter = input.adapters.get(record.providerId)
    if (!adapter) {
      setRecordFailure(record, safeAdapterError('UNAVAILABLE', '执行适配器当前不可用。', true), cycleTime, effects)
      continue
    }
    try {
      const inspected = await adapter.inspect(clone(record.reference), input.signal)
      if (!inspected.ok) {
        setRecordFailure(record, inspected.error, cycleTime, effects)
        continue
      }
      const checked = validateExecutionSnapshot(inspected.value, {
        dispatchId: record.dispatchId,
        taskId: record.taskId,
        providerId: record.providerId,
      })
      if (!checked.ok) {
        setRecordFailure(record, safeAdapterError('INVALID_RESPONSE', '执行适配器返回了无效快照。'), cycleTime, effects)
        continue
      }
      applySnapshot(record, checked.value, effects)
    } catch {
      setRecordFailure(record, safeAdapterError('FAILED', '查询执行状态时发生安全封装后的内部错误。', true), cycleTime, effects)
    }
  }

  const reconciled = await saveState(input.store, state, cycleTime)
  if (!reconciled.ok) return reconciled

  const active = () => state.records.filter(record => ['queued', 'running'].includes(record.phase))
  const activeByProvider = (providerId: ProviderId) => active().filter(record => record.providerId === providerId).length

  for (const task of orderTasksForDispatch(session)) {
    if (aborted(input.signal)) return schedulerError('CANCELLED', '任务协调周期已取消。')
    if (input.canDispatch && !input.canDispatch()) break
    if (active().length >= policyResult.value.globalConcurrency) break
    const run = session.runs.find(candidate => candidate.taskId === task.id)
    if (!run || run.status !== 'ready' || !['api', 'local-agent'].includes(task.executionMode)) continue
    const providerId = run.assignedProviderId
    if (activeByProvider(providerId) >= policyResult.value.providerConcurrency) continue
    const attempt = run.attempt + 1
    if (state.records.some(record => record.taskId === task.id && record.attempt === attempt)) continue
    const dispatchId = createStableDispatchId(session.id, session.plan.id, task.id, attempt, providerId)
    const record: TaskCoordinationRecord = {
      taskId: task.id,
      providerId,
      attempt,
      dispatchId,
      phase: 'dispatching',
      createdAt: cycleTime,
      updatedAt: cycleTime,
    }

    const dependencies = directDependencyHandoffs(session, task)
    if (!dependencies) continue
    state.records.push(record)

    if (task.executionMode === 'api' || task.executionMode === 'local-agent') {
      const handoffMode = task.executionMode === 'local-agent' ? 'local-agent' : 'manual'
      const handoff = getHandoffReadiness(session, task.id, handoffMode, providerId)
      if (!handoff.ready) {
        const message = task.executionMode === 'local-agent'
          ? `仍有 ${handoff.missing.length} 个交接文件未获得读取授权。`
          : `仍有 ${handoff.missing.length} 个交接文件未确认提供给当前 API 执行适配器。`
        setRecordFailure(record, safeAdapterError('NEEDS_INPUT', message), cycleTime, effects)
        const saved = await saveState(input.store, state, cycleTime)
        if (!saved.ok) return saved
        continue
      }
    }

    const adapter = input.adapters.get(providerId)
    if (!adapter) {
      setRecordFailure(record, safeAdapterError('UNAVAILABLE', '没有可用于当前 Provider 的执行适配器。', true), cycleTime, effects)
      const saved = await saveState(input.store, state, cycleTime)
      if (!saved.ok) return saved
      continue
    }

    // Persist the idempotency key before crossing the adapter boundary.
    const intentSaved = await saveState(input.store, state, cycleTime)
    if (!intentSaved.ok) return intentSaved

    // Pause may be requested while the intent is being persisted. Do not cross
    // the adapter boundary after that point, and remove the unspent intent so a
    // later resume can safely create the same deterministic dispatch again.
    if (input.canDispatch && !input.canDispatch()) {
      state.records = state.records.filter(candidate => candidate !== record)
      const pausedSaved = await saveState(input.store, state, cycleTime)
      if (!pausedSaved.ok) return pausedSaved
      break
    }

    const request: ExecutionDispatchRequest = {
      dispatchId,
      sessionId: session.id,
      planId: session.plan.id,
      taskId: task.id,
      attempt,
      providerId,
      task: clone(task),
      directDependencies: dependencies,
    }
    if (!validateExecutionDispatchRequest(request).ok) {
      setRecordFailure(record, safeAdapterError('INVALID_INPUT', '生成的执行派发请求未通过严格校验。'), cycleTime, effects)
      const saved = await saveState(input.store, state, cycleTime)
      if (!saved.ok) return saved
      continue
    }

    try {
      const dispatched = await adapter.dispatch(request, input.signal)
      if (!dispatched.ok) {
        setRecordFailure(record, dispatched.error, cycleTime, effects)
      } else {
        const checked = validateExecutionReceipt(dispatched.value, {
          dispatchId,
          taskId: task.id,
          providerId,
        })
        if (!checked.ok || !['queued', 'running'].includes(checked.ok ? checked.value.state : '')) {
          record.reference = checked.ok ? referenceFromReceipt(checked.value) : undefined
          setRecordFailure(record, safeAdapterError('INVALID_RESPONSE', '执行适配器返回了无效或不完整的接收状态。'), cycleTime, effects)
        } else {
          record.reference = referenceFromReceipt(checked.value)
          record.phase = checked.value.state
          record.error = undefined
          record.updatedAt = checked.value.acceptedAt
          effects.push(makeEffect('dispatch-accepted', record, checked.value.acceptedAt, {
            reference: record.reference,
          }))
          if (checked.value.state === 'running') {
            effects.push(makeEffect('execution-running', record, checked.value.acceptedAt, {
              reference: record.reference,
            }))
          }
        }
      }
    } catch {
      setRecordFailure(
        record,
        safeAdapterError('FAILED', '派发调用结果不确定，需要人工核对，禁止自动重派。'),
        cycleTime,
        effects,
      )
    }
    const resultSaved = await saveState(input.store, state, cycleTime)
    if (!resultSaved.ok) return resultSaved
  }

  const requiresPolling = state.records.some(record => !record.resolution && record.reference && (
    ['queued', 'running', 'needs-input', 'unknown'].includes(record.phase)
    || (record.phase === 'completed' && !record.latestSnapshot)
  ))
  return {
    ok: true,
    value: {
      state: clone(state),
      effects,
      ...(requiresPolling
        ? { nextPollAt: new Date(now().getTime() + policyResult.value.pollIntervalMs).toISOString() }
        : {}),
    },
  }
}

export async function cancelCoordinatedTask(
  input: CancelCoordinatedTaskInput,
): Promise<TaskCoordinatorOutcome<TaskCoordinationCycleResult>> {
  const sessionResult = validateSession(input.session)
  if (!sessionResult.ok) return sessionResult
  if (aborted(input.signal)) return schedulerError('CANCELLED', '取消操作已中止。')
  const session = sessionResult.value
  const loaded = await input.store.load({
    sessionId: session.id,
    planId: session.plan.id,
    taskIds: session.plan.tasks.map(task => task.id),
  })
  if (!loaded.ok) {
    return schedulerError(
      loaded.code === 'STORAGE_UNAVAILABLE' ? 'STORAGE_UNAVAILABLE' : 'CORRUPT_STATE',
      loaded.message,
    )
  }
  if (!loaded.state) return schedulerError('EXECUTION_NOT_FOUND', '没有可取消的协调执行。')
  const state = clone(loaded.state)
  const record = [...state.records]
    .filter(item => item.taskId === input.taskId)
    .sort((left, right) => right.attempt - left.attempt)[0]
  if (!record?.reference) return schedulerError('EXECUTION_NOT_FOUND', '任务没有可取消的执行引用。')
  const adapter = input.adapters.get(record.providerId)
  if (!adapter) return schedulerError('EXECUTION_NOT_FOUND', '对应的执行适配器不可用。')
  const now = input.now ?? (() => new Date())
  try {
    const cancelled = await adapter.cancel(clone(record.reference), input.signal)
    if (!cancelled.ok) return schedulerError(cancelled.error.code === 'CANCELLED' ? 'CANCELLED' : 'FAILED', cancelled.error.message)
    const checked = validateExecutionSnapshot(cancelled.value, {
      dispatchId: record.dispatchId,
      taskId: record.taskId,
      providerId: record.providerId,
    })
    if (!checked.ok) return schedulerError('FAILED', '执行适配器返回了无效取消快照。')
    const effects: TaskCoordinationEffect[] = []
    applySnapshot(record, checked.value, effects)
    const saved = await saveState(input.store, state, now().toISOString())
    if (!saved.ok) return saved
    return { ok: true, value: { state: clone(state), effects } }
  } catch {
    return schedulerError('FAILED', '取消执行时发生安全封装后的内部错误。')
  }
}

