import type {
  EvaluationReport,
  TaskEvaluationAdapter,
  TaskEvaluationRequest,
} from '../types/taskCoordination'
import type { ProviderId } from '../types/taskOrchestration'
import { validateEvaluationReport } from './taskCoordinationValidation'
import { validateTaskEvaluationRequest } from './taskEvaluationValidation'

export type TaskEvaluationAdapterConformanceScenario =
  | 'accepted'
  | 'revise'
  | 'unknown'
  | 'cancel'
  | 'invalid-response'

export interface TaskEvaluationAdapterConformanceFixture {
  providerId: ProviderId
  createAdapter(scenario: TaskEvaluationAdapterConformanceScenario): TaskEvaluationAdapter
  createRequest(): TaskEvaluationRequest
}

export interface TaskEvaluationAdapterConformanceCheckResult {
  id: string
  passed: boolean
  message: string
}

export interface TaskEvaluationAdapterConformanceReport {
  providerId: ProviderId
  passed: boolean
  checks: TaskEvaluationAdapterConformanceCheckResult[]
}

const METHOD_TIMEOUT_MS = 1_000
const clone = <T>(value: T): T => structuredClone(value)
const stable = (value: unknown) => JSON.stringify(value)

const withTimeout = async <T>(operation: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const value = await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('evaluation-conformance-timeout')), METHOD_TIMEOUT_MS)
      }),
    ])
    return { ok: true, value }
  } catch {
    return { ok: false }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

const reportMatches = (
  report: unknown,
  request: TaskEvaluationRequest,
  verdict?: EvaluationReport['verdict'],
): report is EvaluationReport => {
  const checked = validateEvaluationReport(report, {
    taskId: request.taskId,
    dispatchId: request.dispatchId,
  })
  return checked.ok
    && checked.value.evaluationId === request.evaluationId
    && (verdict === undefined || checked.value.verdict === verdict)
}

/** Runs B's zero-network compliance suite for a D-side evaluator. */
export async function runTaskEvaluationAdapterConformance(
  fixture: TaskEvaluationAdapterConformanceFixture,
): Promise<TaskEvaluationAdapterConformanceReport> {
  const checks: TaskEvaluationAdapterConformanceCheckResult[] = []
  const add = (id: string, passed: boolean, success: string, failure: string) => {
    checks.push({ id, passed, message: passed ? success : failure })
  }

  let baseRequest: TaskEvaluationRequest
  try {
    baseRequest = fixture.createRequest()
  } catch {
    add('fixture.request', false, 'Fixture request is valid.', 'Fixture could not create a request.')
    return { providerId: fixture.providerId, passed: false, checks }
  }
  const fixtureValid = validateTaskEvaluationRequest(baseRequest).ok
    && baseRequest.providerId === fixture.providerId
  add('fixture.request', fixtureValid, 'Fixture request is valid.', 'Fixture request or Provider is invalid.')
  if (!fixtureValid) return { providerId: fixture.providerId, passed: false, checks }

  let immutable = true
  const trackedRequest = () => {
    const request = clone(baseRequest)
    const before = stable(request)
    return { request, verify: () => { if (stable(request) !== before) immutable = false } }
  }

  try {
    const adapter = fixture.createAdapter('accepted')
    const tracked = trackedRequest()
    const first = await withTimeout(() => adapter.evaluate(tracked.request, new AbortController().signal))
    const accepted = first.ok && reportMatches(first.value, tracked.request, 'accepted')
    add('report.accepted', accepted, 'Accepted report is valid and correlated.', 'Accepted report is invalid or mismatched.')

    const duplicate = await withTimeout(() => adapter.evaluate(tracked.request, new AbortController().signal))
    const idempotent = first.ok && duplicate.ok
      && reportMatches(duplicate.value, tracked.request)
      && stable(duplicate.value) === stable(first.value)
    add('report.idempotent', idempotent, 'Repeated evaluation is idempotent.', 'Repeated evaluation returned a different report.')

    const conflicting = clone(tracked.request)
    conflicting.task.title = `${conflicting.task.title} conflict`
    const conflict = await withTimeout(() => adapter.evaluate(conflicting, new AbortController().signal))
    add('report.conflict', !conflict.ok, 'Conflicting evaluationId is rejected.', 'Conflicting evaluationId was accepted.')
    tracked.verify()
  } catch {
    add('report.accepted', false, 'Accepted report is valid and correlated.', 'Accepted scenario raised an exception.')
    add('report.idempotent', false, 'Repeated evaluation is idempotent.', 'Idempotency could not be verified.')
    add('report.conflict', false, 'Conflicting evaluationId is rejected.', 'Conflict handling could not be verified.')
  }

  for (const verdict of ['revise', 'unknown'] as const) {
    try {
      const adapter = fixture.createAdapter(verdict)
      const tracked = trackedRequest()
      const outcome = await withTimeout(() => adapter.evaluate(tracked.request, new AbortController().signal))
      add(`report.${verdict}`, outcome.ok && reportMatches(outcome.value, tracked.request, verdict),
        `${verdict} report is valid and correlated.`, `${verdict} report is invalid or mismatched.`)
      tracked.verify()
    } catch {
      add(`report.${verdict}`, false, `${verdict} report is valid and correlated.`, `${verdict} scenario raised an exception.`)
    }
  }

  try {
    const adapter = fixture.createAdapter('cancel')
    const tracked = trackedRequest()
    const controller = new AbortController()
    const pending = withTimeout(() => adapter.evaluate(tracked.request, controller.signal))
    controller.abort()
    const cancelled = await pending
    add('cancel.running', !cancelled.ok, 'Running evaluation can be cancelled.', 'Cancelled evaluation returned a report.')
    tracked.verify()
  } catch {
    add('cancel.running', true, 'Running evaluation can be cancelled.', 'Cancelled evaluation returned a report.')
  }

  try {
    const adapter = fixture.createAdapter('accepted')
    const tracked = trackedRequest()
    const controller = new AbortController()
    controller.abort()
    const cancelled = await withTimeout(() => adapter.evaluate(tracked.request, controller.signal))
    add('cancel.pre-aborted', !cancelled.ok, 'Pre-aborted evaluation does not cross the evaluator boundary.', 'Pre-aborted evaluation returned a report.')
    tracked.verify()
  } catch {
    add('cancel.pre-aborted', true, 'Pre-aborted evaluation does not cross the evaluator boundary.', 'Pre-aborted evaluation returned a report.')
  }

  try {
    const adapter = fixture.createAdapter('invalid-response')
    const tracked = trackedRequest()
    const response = await withTimeout(() => adapter.evaluate(tracked.request, new AbortController().signal))
    const rejected = response.ok && !reportMatches(response.value, tracked.request)
    add('report.invalid-response', rejected, 'Invalid evaluator response is rejected by strict validation.', 'Invalid evaluator response passed validation.')
    tracked.verify()
  } catch {
    add('report.invalid-response', true, 'Invalid evaluator response is rejected by strict validation.', 'Invalid evaluator response passed validation.')
  }

  add('immutability.request', immutable, 'Evaluator does not mutate requests.', 'Evaluator mutated an evaluation request.')
  return { providerId: fixture.providerId, passed: checks.every(check => check.passed), checks }
}
