import type {
  BrainPlanningInput,
  BrainPlanningOutcome,
  BrainProvider,
} from './BrainProvider'
import { validateTaskPlan } from './taskPlanValidation'
import { withDefaultTaskPriorities } from './taskScheduling'
import type {
  BrainPlanningErrorCode,
  TaskBrainId,
  TaskPlan,
  TaskPlanningBrainSource,
} from '../types/taskOrchestration'

export interface TaskBrainProviderSet {
  local: BrainProvider
  deepseek: BrainProvider
}

const FALLBACK_CODES = new Set<BrainPlanningErrorCode>([
  'NOT_CONFIGURED',
  'RATE_LIMITED',
  'UNAVAILABLE',
  'TIMEOUT',
  'INVALID_RESPONSE',
  'FAILED',
])

const safeCreatePlan = async (
  provider: BrainProvider,
  input: BrainPlanningInput,
  signal?: AbortSignal,
): Promise<BrainPlanningOutcome> => {
  if (signal?.aborted) return { ok: false, code: 'CANCELLED', message: '任务拆解已取消。' }
  try {
    return await provider.createPlan(input, signal)
  } catch {
    return { ok: false, code: 'FAILED', message: '任务拆解服务调用失败，请稍后重试。' }
  }
}

const stampAndValidate = (
  plan: TaskPlan,
  source: TaskPlanningBrainSource,
): BrainPlanningOutcome => {
  const value: TaskPlan = {
    ...withDefaultTaskPriorities(plan),
    planningBrain: { ...source },
  }
  const validation = validateTaskPlan(value)
  return validation.ok
    ? { ok: true, plan: validation.plan }
    : { ok: false, code: 'INVALID_RESPONSE', message: '任务方案未通过安全校验。' }
}

export async function createPlanWithTaskBrain(
  requestedBrainId: TaskBrainId,
  input: BrainPlanningInput,
  providers: TaskBrainProviderSet,
  signal?: AbortSignal,
): Promise<BrainPlanningOutcome> {
  const selected = providers[requestedBrainId]
  const primary = await safeCreatePlan(selected, input, signal)
  if (signal?.aborted) return { ok: false, code: 'CANCELLED', message: '任务拆解已取消。' }

  if (primary.ok) {
    const validated = stampAndValidate(primary.plan, {
      requestedBrainId,
      actualBrainId: requestedBrainId,
    })
    if (validated.ok || requestedBrainId === 'local') return validated
    if (!FALLBACK_CODES.has(validated.code)) return validated
    return fallbackToLocal(requestedBrainId, validated.code, input, providers.local, signal)
  }

  if (requestedBrainId === 'local' || !FALLBACK_CODES.has(primary.code)) return primary
  return fallbackToLocal(requestedBrainId, primary.code, input, providers.local, signal)
}

const fallbackToLocal = async (
  requestedBrainId: TaskBrainId,
  fallbackCode: BrainPlanningErrorCode,
  input: BrainPlanningInput,
  localProvider: BrainProvider,
  signal?: AbortSignal,
): Promise<BrainPlanningOutcome> => {
  const fallback = await safeCreatePlan(localProvider, input, signal)
  if (!fallback.ok) return fallback
  return stampAndValidate(fallback.plan, {
    requestedBrainId,
    actualBrainId: 'local',
    fallbackCode,
  })
}
