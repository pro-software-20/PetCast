import type {
  AcceptanceDecision,
  AcceptancePolicy,
  EvaluationReport,
} from '../types/taskCoordination'

export interface AcceptanceDecisionInput {
  report: EvaluationReport
  policy: AcceptancePolicy
  attempt: number
}

/**
 * Produces B's suggested action only. P3.0 deliberately does not mutate a task session.
 */
export function decideTaskAcceptance(input: AcceptanceDecisionInput): AcceptanceDecision {
  const { report, policy, attempt } = input
  const base = {
    evaluationId: report.evaluationId,
    taskId: report.taskId,
    dispatchId: report.dispatchId,
  }

  if (policy.mode === 'manual') {
    return {
      ...base,
      action: 'manual-review',
      reason: 'MANUAL_POLICY',
      requiresHumanConfirmation: true,
    }
  }

  if (!policy.trustedMethods.includes(report.method)) {
    return {
      ...base,
      action: 'manual-review',
      reason: 'UNTRUSTED_METHOD',
      requiresHumanConfirmation: true,
    }
  }

  if (report.verdict === 'unknown') {
    return {
      ...base,
      action: 'manual-review',
      reason: 'EVALUATION_UNKNOWN',
      requiresHumanConfirmation: true,
    }
  }

  if (report.verdict === 'revise') {
    const exhausted = attempt >= policy.maxAttempts
    return {
      ...base,
      action: exhausted ? 'manual-review' : 'request-changes',
      reason: exhausted ? 'MAX_ATTEMPTS_REACHED' : 'REVISION_REQUESTED',
      requiresHumanConfirmation: exhausted,
    }
  }

  const allPassed = report.verification.length > 0
    && report.verification.every(check => check.status === 'passed')
  return {
    ...base,
    action: allPassed ? 'complete' : 'manual-review',
    reason: allPassed ? 'ACCEPTED_AND_VERIFIED' : 'ACCEPTED_WITH_INCOMPLETE_CHECKS',
    requiresHumanConfirmation: !allPassed,
  }
}
