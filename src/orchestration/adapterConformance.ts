import type {
  ExecutionAdapter,
  ExecutionAdapterError,
  ExecutionAdapterOutcome,
  ExecutionDispatchRequest,
  ExecutionReceipt,
  ExecutionReference,
  ExecutionSnapshot,
} from '../types/taskCoordination'
import type { ProviderId } from '../types/taskOrchestration'
import {
  validateExecutionDispatchRequest,
  validateExecutionReceipt,
  validateExecutionSnapshot,
} from './taskCoordinationValidation'

export type AdapterConformanceScenario =
  | 'complete'
  | 'needs-input'
  | 'failed'
  | 'rate-limited'
  | 'cancel'

export interface ExecutionAdapterConformanceFixture {
  providerId: ProviderId
  executionMode: 'api' | 'local-agent'
  createAdapter(scenario: AdapterConformanceScenario): ExecutionAdapter
  createRequest(): ExecutionDispatchRequest
}

export interface AdapterConformanceCheckResult {
  id: string
  passed: boolean
  message: string
}

export interface ExecutionAdapterConformanceReport {
  providerId: ProviderId
  executionMode: 'api' | 'local-agent'
  passed: boolean
  checks: AdapterConformanceCheckResult[]
}

const METHOD_TIMEOUT_MS = 1_000
const MAX_INSPECTIONS = 25
const allowedErrorKeys = new Set(['code', 'retryable', 'message', 'retryAfterSeconds'])
const unsafeMessagePattern = /(?:[a-zA-Z]:[\\/]|\\Users\\|\/Users\/|\/home\/|Bearer\s+|Authorization\s*:|api[_ -]?key|sk-[A-Za-z0-9]|<html|\{\s*"(?:error|message)"\s*:)/i

const clone = <T>(value: T): T => structuredClone(value)
const stable = (value: unknown) => JSON.stringify(value)
const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

const isSafeError = (value: unknown): value is ExecutionAdapterError => {
  if (!isRecord(value) || Object.keys(value).some(key => !allowedErrorKeys.has(key))) return false
  if (typeof value.code !== 'string'
    || typeof value.retryable !== 'boolean'
    || typeof value.message !== 'string'
    || value.message.length === 0
    || value.message.length > 500
    || unsafeMessagePattern.test(value.message)) return false
  return value.retryAfterSeconds === undefined
    || (Number.isInteger(value.retryAfterSeconds) && Number(value.retryAfterSeconds) >= 0)
}

const isFailure = <T>(
  value: ExecutionAdapterOutcome<T> | unknown,
  code?: ExecutionAdapterError['code'],
): value is { ok: false; error: ExecutionAdapterError } => (
  isRecord(value)
  && value.ok === false
  && isSafeError(value.error)
  && (code === undefined || value.error.code === code)
)

const withTimeout = async <T>(
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false }> => {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const value = await Promise.race([
      operation(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error('adapter-conformance-timeout'))
        }, METHOD_TIMEOUT_MS)
      }),
    ])
    return { ok: true, value }
  } catch {
    return { ok: false }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

const createReference = (receipt: ExecutionReceipt): ExecutionReference => ({
  dispatchId: receipt.dispatchId,
  adapterExecutionId: receipt.adapterExecutionId,
  taskId: receipt.taskId,
})

const inspectUntil = async (
  adapter: ExecutionAdapter,
  reference: ExecutionReference,
  terminalStates: Set<ExecutionSnapshot['state']>,
): Promise<ExecutionAdapterOutcome<ExecutionSnapshot> | undefined> => {
  for (let index = 0; index < MAX_INSPECTIONS; index += 1) {
    const inspected = await withTimeout(signal => adapter.inspect(reference, signal))
    if (!inspected.ok) return undefined
    const outcome = inspected.value
    if (!isRecord(outcome) || typeof outcome.ok !== 'boolean') return outcome
    if (!outcome.ok || terminalStates.has(outcome.value.state)) return outcome
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  return undefined
}

const receiptMatches = (value: unknown, request: ExecutionDispatchRequest): value is ExecutionReceipt => (
  validateExecutionReceipt(value, { dispatchId: request.dispatchId, taskId: request.taskId }).ok
)

const snapshotMatches = (
  value: unknown,
  request: ExecutionDispatchRequest,
  receipt: ExecutionReceipt,
): value is ExecutionSnapshot => {
  const validated = validateExecutionSnapshot(value, {
    dispatchId: request.dispatchId,
    taskId: request.taskId,
    providerId: request.providerId,
  })
  return validated.ok
    && isRecord(value)
    && value.adapterExecutionId === receipt.adapterExecutionId
}

/** Runs the B-side zero-network compliance contract for an A-side adapter. */
export async function runExecutionAdapterConformance(
  fixture: ExecutionAdapterConformanceFixture,
): Promise<ExecutionAdapterConformanceReport> {
  const checks: AdapterConformanceCheckResult[] = []
  const add = (id: string, passed: boolean, success: string, failure: string) => {
    checks.push({ id, passed, message: passed ? success : failure })
  }

  let baseRequest: ExecutionDispatchRequest
  try {
    baseRequest = fixture.createRequest()
  } catch {
    add('fixture.request', false, 'Fixture request is valid.', 'Fixture could not create a request.')
    return { providerId: fixture.providerId, executionMode: fixture.executionMode, passed: false, checks }
  }
  const fixtureValid = validateExecutionDispatchRequest(baseRequest).ok
    && baseRequest.providerId === fixture.providerId
    && baseRequest.task.executionMode === fixture.executionMode
  add('fixture.request', fixtureValid, 'Fixture request is valid.', 'Fixture request or identity is invalid.')
  if (!fixtureValid) {
    return { providerId: fixture.providerId, executionMode: fixture.executionMode, passed: false, checks }
  }

  let allInputsImmutable = true
  let allErrorsSafe = true
  const requestFor = () => {
    const request = clone(baseRequest)
    const before = stable(request)
    return { request, verify: () => { if (stable(request) !== before) allInputsImmutable = false } }
  }

  try {
    const adapter = fixture.createAdapter('complete')
    const tracked = requestFor()
    const firstCall = await withTimeout(signal => adapter.dispatch(tracked.request, signal))
    const first = firstCall.ok ? firstCall.value : undefined
    const receipt = first && isRecord(first) && first.ok === true && receiptMatches(first.value, tracked.request)
      ? first.value
      : undefined
    add('dispatch.receipt', Boolean(receipt), 'Dispatch receipt is valid.', 'Dispatch receipt is invalid or timed out.')

    const duplicateCall = await withTimeout(signal => adapter.dispatch(tracked.request, signal))
    const duplicate = duplicateCall.ok ? duplicateCall.value : undefined
    const duplicateValid = Boolean(receipt && duplicate && isRecord(duplicate) && duplicate.ok === true
      && receiptMatches(duplicate.value, tracked.request) && stable(duplicate.value) === stable(receipt))
    add('dispatch.idempotent', duplicateValid, 'Repeated dispatch is idempotent.', 'Repeated dispatch created a different execution.')

    const conflict = clone(tracked.request)
    conflict.task.title = `${conflict.task.title} conflict`
    const conflictCall = await withTimeout(signal => adapter.dispatch(conflict, signal))
    const conflictOutcome = conflictCall.ok ? conflictCall.value : undefined
    const conflictRejected = isFailure(conflictOutcome, 'INVALID_INPUT')
    if (isRecord(conflictOutcome) && conflictOutcome.ok === false && !isSafeError(conflictOutcome.error)) allErrorsSafe = false
    add('dispatch.conflict', conflictRejected, 'Conflicting dispatchId is rejected.', 'Conflicting dispatchId was not safely rejected.')

    if (receipt) {
      const reference = createReference(receipt)
      const completed = await inspectUntil(adapter, reference, new Set(['completed', 'failed']))
      const completedValid = Boolean(completed && isRecord(completed) && completed.ok === true
        && snapshotMatches(completed.value, tracked.request, receipt) && completed.value.state === 'completed')
      add('complete.result', completedValid, 'Completed result is valid and correlated.', 'Completed result is invalid or mismatched.')

      const recovery = await withTimeout(signal => adapter.inspect(reference, signal))
      const recoveryValid = Boolean(recovery.ok && isRecord(recovery.value) && recovery.value.ok === true
        && snapshotMatches(recovery.value.value, tracked.request, receipt))
      add('recovery.inspect-only', recoveryValid, 'Recovery preserves the existing execution.', 'Recovery did not preserve the execution reference.')

      const unknown = await withTimeout(signal => adapter.inspect({ ...reference, adapterExecutionId: `${reference.adapterExecutionId}-unknown` }, signal))
      const unknownOutcome = unknown.ok ? unknown.value : undefined
      const unknownRejected = isFailure(unknownOutcome, 'EXECUTION_NOT_FOUND')
      if (isRecord(unknownOutcome) && unknownOutcome.ok === false && !isSafeError(unknownOutcome.error)) allErrorsSafe = false
      add('recovery.unknown', unknownRejected, 'Unknown execution is safely rejected.', 'Unknown execution did not return EXECUTION_NOT_FOUND.')
    } else {
      add('complete.result', false, 'Completed result is valid and correlated.', 'Completed result could not be inspected.')
      add('recovery.inspect-only', false, 'Recovery preserves the existing execution.', 'Recovery could not be inspected.')
      add('recovery.unknown', false, 'Unknown execution is safely rejected.', 'Unknown execution check could not run.')
    }
    tracked.verify()
  } catch {
    add('complete.scenario', false, 'Complete scenario passed.', 'Complete scenario raised an adapter exception.')
  }

  const terminalScenarios: Array<{
    scenario: 'needs-input' | 'failed' | 'rate-limited'
    state: 'needs-input' | 'failed'
    code: ExecutionAdapterError['code']
  }> = [
    { scenario: 'needs-input', state: 'needs-input', code: 'NEEDS_INPUT' },
    { scenario: 'failed', state: 'failed', code: 'FAILED' },
    { scenario: 'rate-limited', state: 'failed', code: 'RATE_LIMITED' },
  ]
  for (const expected of terminalScenarios) {
    try {
      const adapter = fixture.createAdapter(expected.scenario)
      const tracked = requestFor()
      const dispatched = await withTimeout(signal => adapter.dispatch(tracked.request, signal))
      const outcome = dispatched.ok ? dispatched.value : undefined
      const receipt = outcome && isRecord(outcome) && outcome.ok === true && receiptMatches(outcome.value, tracked.request)
        ? outcome.value
        : undefined
      let passed = false
      if (receipt) {
        const terminal = await inspectUntil(adapter, createReference(receipt), new Set([expected.state]))
        if (terminal && isRecord(terminal) && terminal.ok === true) {
          const snapshot = terminal.value
          passed = snapshotMatches(snapshot, tracked.request, receipt)
            && snapshot.state === expected.state
            && snapshot.error?.code === expected.code
            && isSafeError(snapshot.error)
          if (!isSafeError(snapshot.error)) allErrorsSafe = false
          if (expected.scenario === 'rate-limited') {
            passed = passed && snapshot.error?.retryable === true && Number.isInteger(snapshot.error.retryAfterSeconds)
          }
        }
      }
      add(`state.${expected.scenario}`, passed, `${expected.scenario} is safely mapped.`, `${expected.scenario} mapping is invalid.`)
      tracked.verify()
    } catch {
      add(`state.${expected.scenario}`, false, `${expected.scenario} is safely mapped.`, `${expected.scenario} scenario raised an adapter exception.`)
    }
  }

  try {
    const adapter = fixture.createAdapter('cancel')
    const tracked = requestFor()
    const dispatched = await withTimeout(signal => adapter.dispatch(tracked.request, signal))
    const outcome = dispatched.ok ? dispatched.value : undefined
    const receipt = outcome && isRecord(outcome) && outcome.ok === true && receiptMatches(outcome.value, tracked.request)
      ? outcome.value
      : undefined
    let cancelledValid = false
    let repeatedValid = false
    if (receipt) {
      const reference = createReference(receipt)
      const firstCancel = await withTimeout(signal => adapter.cancel(reference, signal))
      const secondCancel = await withTimeout(signal => adapter.cancel(reference, signal))
      cancelledValid = Boolean(firstCancel.ok && isRecord(firstCancel.value) && firstCancel.value.ok === true
        && snapshotMatches(firstCancel.value.value, tracked.request, receipt) && firstCancel.value.value.state === 'cancelled')
      repeatedValid = Boolean(secondCancel.ok && isRecord(secondCancel.value) && secondCancel.value.ok === true
        && snapshotMatches(secondCancel.value.value, tracked.request, receipt) && secondCancel.value.value.state === 'cancelled')
    }
    add('cancel.running', cancelledValid, 'Running execution can be cancelled.', 'Running cancellation is invalid.')
    add('cancel.idempotent', repeatedValid, 'Repeated cancellation is idempotent.', 'Repeated cancellation is not idempotent.')
    tracked.verify()
  } catch {
    add('cancel.running', false, 'Running execution can be cancelled.', 'Cancellation scenario raised an adapter exception.')
    add('cancel.idempotent', false, 'Repeated cancellation is idempotent.', 'Repeated cancellation could not be verified.')
  }

  try {
    const adapter = fixture.createAdapter('complete')
    const tracked = requestFor()
    const controller = new AbortController()
    controller.abort()
    const outcome = await adapter.dispatch(tracked.request, controller.signal)
    const passed = isFailure(outcome, 'CANCELLED')
    if (isRecord(outcome) && outcome.ok === false && !isSafeError(outcome.error)) allErrorsSafe = false
    add('abort.pre-cancelled', passed, 'Pre-aborted dispatch is rejected.', 'Pre-aborted dispatch crossed the adapter boundary.')
    tracked.verify()
  } catch {
    add('abort.pre-cancelled', false, 'Pre-aborted dispatch is rejected.', 'Pre-aborted dispatch raised an adapter exception.')
  }

  add('security.errors', allErrorsSafe, 'Adapter errors are structured and safe.', 'Adapter errors contain unsafe or unknown data.')
  add('immutability.requests', allInputsImmutable, 'Adapter does not mutate dispatch requests.', 'Adapter mutated a dispatch request.')
  return { providerId: fixture.providerId, executionMode: fixture.executionMode, passed: checks.every(check => check.passed), checks }
}
