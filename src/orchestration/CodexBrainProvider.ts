import { DeepSeekBrainProvider } from './DeepSeekBrainProvider'
import { TASK_BRAIN_PROFILES } from './taskBrainProfiles'
import type { BrainPlanningInput, BrainPlanningOutcome } from './BrainProvider'

/** Reuse the same metadata-only request and task-graph validation as the API planner. */
export class CodexBrainProvider extends DeepSeekBrainProvider {
  readonly profile = TASK_BRAIN_PROFILES.codex
  constructor() {
    const bridge = typeof window !== 'undefined' ? window.petcast : undefined
    super(bridge?.planTaskWithCodex && bridge.cancelCodexTaskPlan ? {
      planTaskWithDeepSeek: input => bridge.planTaskWithCodex(input),
      cancelDeepSeekTaskPlan: id => bridge.cancelCodexTaskPlan(id),
    } : undefined)
  }
  async createPlan(input: BrainPlanningInput, signal?: AbortSignal): Promise<BrainPlanningOutcome> {
    if (typeof window === 'undefined' || !window.petcast?.planTaskWithCodex) {
      return { ok: false, code: 'NOT_CONFIGURED', message: '请在桌面版连接本机 Codex。' }
    }
    const result = await super.createPlan(input, signal)
    return result.ok ? result : { ...result, message: result.message.replaceAll('DeepSeek', 'Codex') }
  }
}
