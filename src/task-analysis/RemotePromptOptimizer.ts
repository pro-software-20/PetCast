import type {
  PromptOptimizationRequest,
  PromptOptimizationResult as RemotePromptOptimizationResult,
} from '../../electron/promptOptimizationProtocol'
import {
  localPromptOptimizer,
  type PromptOptimizationContext,
  type PromptOptimizationResult,
  type PromptOptimizer,
} from './promptOptimizer'

export type PromptOptimizationBridge = (
  input: PromptOptimizationRequest,
) => Promise<RemotePromptOptimizationResult>

const fallbackMessages: Record<Exclude<RemotePromptOptimizationResult, { ok: true }>['code'], string> = {
  INVALID_REQUEST: 'AI 优化请求无效，已使用本地规则优化。',
  RATE_LIMITED: 'AI 优化请求过于频繁，已使用本地规则优化，请稍后再试。',
  UPSTREAM_TIMEOUT: 'AI 优化服务响应超时，已使用本地规则优化。',
  UPSTREAM_UNAVAILABLE: 'AI 优化服务暂不可用或尚未配置，已使用本地规则优化。',
  INVALID_RESPONSE: 'AI 优化服务返回了无法识别的结果，已使用本地规则优化。',
}

export class RemotePromptOptimizer implements PromptOptimizer {
  constructor(private readonly bridge?: PromptOptimizationBridge) {}

  async optimize(prompt: string, context: PromptOptimizationContext): Promise<PromptOptimizationResult> {
    const fallback = await localPromptOptimizer.optimize(prompt, context)
    if (!prompt.trim()) return fallback
    if (!this.bridge) {
      return {
        ...fallback,
        warning: fallbackMessages.UPSTREAM_UNAVAILABLE,
      }
    }

    try {
      const result = await this.bridge({
        prompt,
        taskType: context.taskType,
        files: context.files,
      })
      if (result.ok) {
        return {
          optimizedPrompt: result.optimizedPrompt,
          source: 'deepseek',
        }
      }
      return {
        ...fallback,
        warning: result.retryAfterSeconds
          ? `${fallbackMessages[result.code]} 建议等待约 ${result.retryAfterSeconds} 秒。`
          : fallbackMessages[result.code],
      }
    } catch {
      return {
        ...fallback,
        warning: fallbackMessages.UPSTREAM_UNAVAILABLE,
      }
    }
  }
}

export const createDefaultPromptOptimizer = (): PromptOptimizer => {
  const bridge = typeof window === 'undefined' ? undefined : window.petcast?.optimizeTaskPrompt
  return new RemotePromptOptimizer(bridge)
}
