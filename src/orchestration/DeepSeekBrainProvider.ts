import type { BrainPlanningInput, BrainPlanningOutcome, BrainProvider } from './BrainProvider'
import { DEEPSEEK_TASK_BRAIN_PROFILE } from './taskBrainProfiles'

/**
 * P2.9A contract placeholder. P2.9B will add the trusted Electron bridge here.
 * It deliberately performs no network or IPC call in this phase.
 */
export class DeepSeekBrainProvider implements BrainProvider {
  readonly profile = DEEPSEEK_TASK_BRAIN_PROFILE

  async createPlan(_input: BrainPlanningInput, signal?: AbortSignal): Promise<BrainPlanningOutcome> {
    if (signal?.aborted) {
      return { ok: false, code: 'CANCELLED', message: '任务拆解已取消。' }
    }
    return {
      ok: false,
      code: 'NOT_CONFIGURED',
      message: 'DeepSeek 任务规划尚未接入，已准备使用本地规则。',
    }
  }
}
