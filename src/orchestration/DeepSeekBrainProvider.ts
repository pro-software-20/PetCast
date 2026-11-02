import type {
  TaskPlanningIpcRequest,
  TaskPlanningServiceResult,
} from '../../electron/taskPlanningProtocol'
import type { BrainPlanningInput, BrainPlanningOutcome, BrainProvider } from './BrainProvider'
import type { TaskPlan } from '../types/taskOrchestration'
import { DEEPSEEK_TASK_BRAIN_PROFILE } from './taskBrainProfiles'

export interface DeepSeekTaskPlanningBridge {
  planTaskWithDeepSeek(input: TaskPlanningIpcRequest): Promise<TaskPlanningServiceResult>
  cancelDeepSeekTaskPlan(requestId: string): void
}

const browserBridge = (): DeepSeekTaskPlanningBridge | undefined => {
  if (typeof window === 'undefined') return undefined
  const bridge = window.petcast
  if (typeof bridge?.planTaskWithDeepSeek !== 'function'
    || typeof bridge.cancelDeepSeekTaskPlan !== 'function') return undefined
  return bridge
}

const createRequestId = () => {
  const uuid = globalThis.crypto?.randomUUID?.()
  return uuid ? `plan-${uuid}` : `plan-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

const errorOutcome = (
  result: Extract<TaskPlanningServiceResult, { ok: false }>,
): BrainPlanningOutcome => {
  switch (result.code) {
    case 'INVALID_REQUEST':
      return { ok: false, code: 'INVALID_INPUT', message: '任务规划输入无效。' }
    case 'RATE_LIMITED':
      return { ok: false, code: 'RATE_LIMITED', message: 'DeepSeek 任务规划请求过于频繁，请稍后重试。' }
    case 'UPSTREAM_TIMEOUT':
      return { ok: false, code: 'TIMEOUT', message: 'DeepSeek 任务规划超时。' }
    case 'INVALID_RESPONSE':
      return { ok: false, code: 'INVALID_RESPONSE', message: 'DeepSeek 返回的任务方案未通过安全校验。' }
    default:
      return { ok: false, code: 'UNAVAILABLE', message: 'DeepSeek 任务规划服务暂时不可用。' }
  }
}

export class DeepSeekBrainProvider implements BrainProvider {
  readonly profile = DEEPSEEK_TASK_BRAIN_PROFILE

  constructor(private readonly bridge: DeepSeekTaskPlanningBridge | undefined = browserBridge()) {}

  async createPlan(input: BrainPlanningInput, signal?: AbortSignal): Promise<BrainPlanningOutcome> {
    if (signal?.aborted) return { ok: false, code: 'CANCELLED', message: '任务拆解已取消。' }
    if (!this.bridge) {
      return { ok: false, code: 'UNAVAILABLE', message: 'DeepSeek 任务规划仅在已配置服务的桌面版中可用。' }
    }

    const id = createRequestId()
    const cancel = () => this.bridge?.cancelDeepSeekTaskPlan(id)
    signal?.addEventListener('abort', cancel, { once: true })
    try {
      const result = await this.bridge.planTaskWithDeepSeek({
        requestId: id,
        input: {
          prompt: input.analysisInput.prompt,
          analysis: { ...input.analysisResult },
          files: input.analysisInput.files.map(file => ({ ...file })),
          providers: input.availableProviders.map(provider => ({
            id: provider.id,
            displayName: provider.displayName,
            capabilities: [...provider.capabilities],
            executionModes: [...provider.executionModes],
          })),
        },
      })
      if (signal?.aborted) return { ok: false, code: 'CANCELLED', message: '任务拆解已取消。' }
      return result.ok ? { ok: true, plan: result.plan as TaskPlan } : errorOutcome(result)
    } catch {
      return signal?.aborted
        ? { ok: false, code: 'CANCELLED', message: '任务拆解已取消。' }
        : { ok: false, code: 'UNAVAILABLE', message: 'DeepSeek 任务规划服务暂时不可用。' }
    } finally {
      signal?.removeEventListener('abort', cancel)
    }
  }
}
