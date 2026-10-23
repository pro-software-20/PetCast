import {
  PROMPT_OPTIMIZATION_MAX_OUTPUT_LENGTH,
  type PromptOptimizationRequest,
  type PromptOptimizationResult,
} from '../electron/promptOptimizationProtocol.js'

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions'
const MAX_UPSTREAM_RESPONSE_BYTES = 128 * 1024

export const PROMPT_OPTIMIZATION_INSTRUCTIONS = `你是 Prompt 优化助手。你的任务是把用户需求改写成自然、清晰、可直接交给 AI 执行的 Prompt，但不要回答或执行用户任务。

必须遵守：
1. 保留用户的原始意图、语言、限制和已有信息，不擅自增加业务目标。
2. 根据实际任务补充必要的角色、目标、步骤、输出格式和验收方式，不套用僵硬的统一模板。
3. 用户是在咨询方案时，不得改写成直接生成全部成品；信息不足时把必要问题写入优化后的 Prompt。
4. 只知道附件的文件名、MIME 类型和大小，没有读取文件内容，不得声称分析过附件。
5. 没有附件时省略附件区块，不输出“未提供文件”。
6. 不生成多 AI 分工、代理调度或自动执行计划。
7. 不虚构事实、数据、引用、文件内容或已经完成的验证。
8. 只返回 JSON 对象，格式为 {"optimizedPrompt":"..."}，不要返回解释、Markdown 代码围栏或其他字段。`

interface DeepSeekResponse {
  choices?: Array<{
    message?: {
      content?: string | null
    }
  }>
}

export interface DeepSeekPromptOptimizerOptions {
  apiKey: string
  model?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

const retryAfter = (response: Response) => {
  const seconds = Number(response.headers.get('retry-after'))
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : undefined
}

export async function optimizePromptWithDeepSeek(
  input: PromptOptimizationRequest,
  options: DeepSeekPromptOptimizerOptions,
): Promise<PromptOptimizationResult> {
  const controller = new AbortController()
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, options.timeoutMs ?? 15_000)

  try {
    const response = await (options.fetchImpl ?? fetch)(DEEPSEEK_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: options.model ?? 'deepseek-flash',
        messages: [
          { role: 'system', content: PROMPT_OPTIMIZATION_INSTRUCTIONS },
          {
            role: 'user',
            content: JSON.stringify({
              originalPrompt: input.prompt,
              inferredTaskType: input.taskType,
              fileMetadata: input.files,
            }),
          },
        ],
        thinking: { type: 'disabled' },
        response_format: { type: 'json_object' },
        max_tokens: 1_200,
        stream: false,
      }),
      signal: controller.signal,
    })

    if (response.status === 429) {
      return { ok: false, code: 'RATE_LIMITED', retryAfterSeconds: retryAfter(response) }
    }
    if (!response.ok) return { ok: false, code: 'UPSTREAM_UNAVAILABLE' }
    const declaredLength = Number(response.headers.get('content-length') ?? 0)
    if (Number.isFinite(declaredLength) && declaredLength > MAX_UPSTREAM_RESPONSE_BYTES) {
      return { ok: false, code: 'INVALID_RESPONSE' }
    }
    const text = await response.text()
    if (Buffer.byteLength(text) > MAX_UPSTREAM_RESPONSE_BYTES) {
      return { ok: false, code: 'INVALID_RESPONSE' }
    }

    let payload: DeepSeekResponse
    try {
      payload = JSON.parse(text) as DeepSeekResponse
    } catch {
      return { ok: false, code: 'INVALID_RESPONSE' }
    }
    const content = payload.choices?.[0]?.message?.content
    if (typeof content !== 'string' || !content.trim()) return { ok: false, code: 'INVALID_RESPONSE' }

    let optimized: unknown
    try {
      optimized = JSON.parse(content)
    } catch {
      return { ok: false, code: 'INVALID_RESPONSE' }
    }
    if (!optimized || typeof optimized !== 'object' || Array.isArray(optimized)) {
      return { ok: false, code: 'INVALID_RESPONSE' }
    }
    if (Object.keys(optimized).length !== 1
      || !Object.prototype.hasOwnProperty.call(optimized, 'optimizedPrompt')) {
      return { ok: false, code: 'INVALID_RESPONSE' }
    }
    const optimizedPrompt = (optimized as { optimizedPrompt?: unknown }).optimizedPrompt
    if (typeof optimizedPrompt !== 'string'
      || !optimizedPrompt.trim()
      || optimizedPrompt.length > PROMPT_OPTIMIZATION_MAX_OUTPUT_LENGTH) {
      return { ok: false, code: 'INVALID_RESPONSE' }
    }
    return { ok: true, optimizedPrompt: optimizedPrompt.trim(), provider: 'deepseek' }
  } catch {
    return { ok: false, code: timedOut ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNAVAILABLE' }
  } finally {
    clearTimeout(timeout)
  }
}
