import type {
  EvaluationReport,
  TaskEvaluationAdapter,
  TaskEvaluationRequest,
} from '../types/taskCoordination'
import type {
  TaskEvaluationAdapterConformanceFixture,
  TaskEvaluationAdapterConformanceScenario,
} from './evaluationAdapterConformance'

const fingerprint = (value: unknown) => JSON.stringify(value)

export class InMemoryTaskEvaluationAdapter implements TaskEvaluationAdapter {
  private readonly requests = new Map<string, string>()
  private readonly reports = new Map<string, EvaluationReport>()

  constructor(private readonly scenario: TaskEvaluationAdapterConformanceScenario) {}

  async evaluate(request: TaskEvaluationRequest, signal: AbortSignal): Promise<EvaluationReport> {
    if (signal.aborted) throw new DOMException('Evaluation cancelled.', 'AbortError')
    const before = this.requests.get(request.evaluationId)
    const current = fingerprint(request)
    if (before !== undefined && before !== current) throw new Error('INVALID_INPUT')
    const existing = this.reports.get(request.evaluationId)
    if (existing) return structuredClone(existing)
    this.requests.set(request.evaluationId, current)

    if (this.scenario === 'cancel') {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(new DOMException('Evaluation cancelled.', 'AbortError'))
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      })
    }
    const verdict = this.scenario === 'revise' || this.scenario === 'unknown'
      ? this.scenario
      : 'accepted'
    const report: EvaluationReport = {
      evaluationId: request.evaluationId,
      dispatchId: request.dispatchId,
      taskId: request.taskId,
      verdict,
      verification: request.task.acceptanceChecks.map(label => ({
        label,
        status: verdict === 'accepted' ? 'passed' : verdict === 'revise' ? 'failed' : 'not-run',
      })),
      method: 'rubric',
      ruleVersion: 'fixture-v1',
      comparisonBasis: 'Zero-network conformance fixture.',
      evidence: request.result.evidence,
      note: '',
      createdAt: '2026-11-07T00:00:00.000Z',
    }
    if (this.scenario === 'invalid-response') {
      Object.assign(report, { providerResponse: 'unsafe unknown field' })
    }
    this.reports.set(request.evaluationId, structuredClone(report))
    return report
  }
}

export const createTaskEvaluationRequestFixture = (): TaskEvaluationRequest => ({
  evaluationId: 'evaluation-conformance-1',
  sessionId: 'session-conformance-1',
  planId: 'plan-conformance-1',
  taskId: 'task-conformance-1',
  dispatchId: 'dispatch-conformance-1',
  attempt: 1,
  providerId: 'deepseek',
  task: {
    id: 'task-conformance-1',
    title: 'Evaluate a completed task',
    description: 'Compare the safe execution summary with the acceptance checks.',
    expectedDeliverables: ['A structured result'],
    acceptanceChecks: ['The result is structurally valid'],
  },
  result: {
    summary: 'The zero-network execution fixture completed.',
    verification: [{ label: 'The result is structurally valid', status: 'passed' }],
    changedFiles: ['docs/result.md'],
    evidence: [{
      type: 'test-log',
      reference: 'ledger:test-log:conformance-1',
      summary: 'Fixture checks passed.',
    }],
  },
})

export const createInMemoryTaskEvaluationAdapterConformanceFixture = (
): TaskEvaluationAdapterConformanceFixture => ({
  providerId: 'deepseek',
  createAdapter: scenario => new InMemoryTaskEvaluationAdapter(scenario),
  createRequest: createTaskEvaluationRequestFixture,
})

export const createInMemoryTaskEvaluationAdapter = (
  scenario: TaskEvaluationAdapterConformanceScenario = 'accepted',
): TaskEvaluationAdapter => new InMemoryTaskEvaluationAdapter(scenario)
