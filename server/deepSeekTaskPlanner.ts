import {
  sanitizeRemoteTaskPlan,
  TASK_PLANNING_MAX_RESPONSE_BYTES,
  type TaskPlanningRequest,
  type TaskPlanningServiceResult,
} from '../electron/taskPlanningProtocol.js'
import {
  classifyDeepSeekHttpStatus,
  mapDeepSeekDiagnosticToServiceCode,
  type DeepSeekDiagnosticEvent,
} from './deepSeekDiagnostics.js'

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions'

export const TASK_PLANNING_INSTRUCTIONS = `你是 PetCast 的任务拆解大脑。你只负责把用户目标拆成安全、可执行、可验收的任务图，不回答原任务，也不执行任务。

必须遵守：
1. 只返回 JSON 对象，格式为 {"plan":{...}}，不要返回解释或 Markdown 代码围栏。
2. plan 必须使用 schemaVersion 1，并包含 id、title、goal、assumptions、tasks、finalAcceptanceChecks。
3. 最多生成 50 个任务；任务 ID 仅使用字母、数字、下划线和连字符。
4. dependsOn 必须引用同一方案内已有任务，不能自依赖或形成循环；相互独立的任务不要强制串行。
5. 每个任务必须包含 id、title、description、dependsOn、recommendedProviderId、executionMode、prompt、files、expectedDeliverables、acceptanceChecks。
6. executionMode 固定为 manual；recommendedProviderId 只能从用户数据中的 availableProviders 选择。
7. files.inputs 只能引用用户数据中完全一致的附件元信息，kind 固定为 attachment；readPaths、allowedWritePaths、forbiddenPaths、outputPaths 必须为空数组。
8. 不得生成 workspace、planningBrain、绝对路径、工作区路径、文件内容、账号、密钥、额度、费用或自动执行状态。
9. 根据每个子任务的真实性质推荐执行 AI：代码实现/运行测试优先 Codex，研究分析优先 DeepSeek，中文写作润色优先豆包；不可用时选择具备所需能力的 Provider。
10. 每个任务都要给出专属 Prompt、明确交付物和可人工判断的验收标准。
11. 不虚构已经读取附件、已经完成验证或已经获得项目文件。
12. assumptions 和最终验收项应简洁，不要复制完整原 Prompt。`

interface DeepSeekResponse {
  choices?: Array<{ message?: { content?: string | null } }>
}

export const TASK_PLANNING_QUALITY_INSTRUCTIONS = `${TASK_PLANNING_INSTRUCTIONS}

规划质量要求：
13. 普通目标优先生成 2–6 个高价值任务；只有用户目标确实复杂时才增加任务，禁止机械套用“分析—执行—总结”。
14. 用户明确列出的编号任务应保留其独立意图；彼此不依赖的任务保持为根任务，不得为了排序而添加依赖。
15. 汇总、整合或最终验收任务应依赖它实际使用的所有直接产出；不要让无关分支互相等待。
16. 每个任务 Prompt 必须明确写出阶段目标、可用的前置输入、预期交付物和验收方式。
17. recommendedProviderId 只需使用可用 Provider 中的合理值；客户端会依据公开能力重新计算最终执行 AI 推荐。
18. 标题、描述、交付物和验收项必须具体，禁止使用“处理任务”“继续工作”“完成后续”等空泛表述。`

export interface DeepSeekTaskPlannerOptions {
  apiKey: string
  model?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
  onDiagnostic?: (event: DeepSeekDiagnosticEvent) => void
}

const retryAfter = (response: Response) => {
  const seconds = Number(response.headers.get('retry-after'))
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : undefined
}

const emitDiagnostic = (
  options: DeepSeekTaskPlannerOptions,
  event: DeepSeekDiagnosticEvent,
) => {
  try {
    options.onDiagnostic?.(event)
  } catch {
    // Diagnostics must never alter the public planning outcome.
  }
}

export async function planTasksWithDeepSeek(
  input: TaskPlanningRequest,
  options: DeepSeekTaskPlannerOptions,
): Promise<TaskPlanningServiceResult> {
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
          { role: 'system', content: TASK_PLANNING_QUALITY_INSTRUCTIONS },
          {
            role: 'user',
            content: JSON.stringify({
              originalPrompt: input.prompt,
              localAnalysis: input.analysis,
              fileMetadata: input.files,
              availableProviders: input.providers,
            }),
          },
        ],
        thinking: { type: 'disabled' },
        response_format: { type: 'json_object' },
        max_tokens: 4_000,
        stream: false,
      }),
      signal: controller.signal,
    })
    if (response.status === 429) {
      emitDiagnostic(options, {
        code: 'RATE_LIMITED',
        stage: 'planning',
        httpStatus: response.status,
        retryAfterSeconds: retryAfter(response),
      })
      return { ok: false, code: 'RATE_LIMITED', retryAfterSeconds: retryAfter(response) }
    }
    if (!response.ok) {
      const diagnosticCode = classifyDeepSeekHttpStatus(response.status)
      emitDiagnostic(options, {
        code: diagnosticCode,
        stage: 'planning',
        httpStatus: response.status,
      })
      return { ok: false, code: mapDeepSeekDiagnosticToServiceCode(diagnosticCode) }
    }
    const declaredLength = Number(response.headers.get('content-length') ?? 0)
    if (Number.isFinite(declaredLength) && declaredLength > TASK_PLANNING_MAX_RESPONSE_BYTES) {
      emitDiagnostic(options, { code: 'INVALID_RESPONSE', stage: 'planning', httpStatus: response.status })
      return { ok: false, code: 'INVALID_RESPONSE' }
    }
    const text = await response.text()
    if (Buffer.byteLength(text) > TASK_PLANNING_MAX_RESPONSE_BYTES) {
      emitDiagnostic(options, { code: 'INVALID_RESPONSE', stage: 'planning', httpStatus: response.status })
      return { ok: false, code: 'INVALID_RESPONSE' }
    }
    let payload: DeepSeekResponse
    try {
      payload = JSON.parse(text) as DeepSeekResponse
    } catch {
      emitDiagnostic(options, { code: 'INVALID_RESPONSE', stage: 'planning', httpStatus: response.status })
      return { ok: false, code: 'INVALID_RESPONSE' }
    }
    const content = payload.choices?.[0]?.message?.content
    if (typeof content !== 'string' || !content.trim()) {
      emitDiagnostic(options, { code: 'INVALID_RESPONSE', stage: 'planning', httpStatus: response.status })
      return { ok: false, code: 'INVALID_RESPONSE' }
    }
    let generated: unknown
    try {
      generated = JSON.parse(content)
    } catch {
      emitDiagnostic(options, { code: 'INVALID_RESPONSE', stage: 'planning', httpStatus: response.status })
      return { ok: false, code: 'INVALID_RESPONSE' }
    }
    if (!generated || typeof generated !== 'object' || Array.isArray(generated)
      || Object.keys(generated).length !== 1 || !Object.prototype.hasOwnProperty.call(generated, 'plan')) {
      emitDiagnostic(options, { code: 'INVALID_RESPONSE', stage: 'planning', httpStatus: response.status })
      return { ok: false, code: 'INVALID_RESPONSE' }
    }
    const plan = sanitizeRemoteTaskPlan((generated as { plan?: unknown }).plan, input)
    if (!plan) {
      emitDiagnostic(options, { code: 'INVALID_RESPONSE', stage: 'planning', httpStatus: response.status })
      return { ok: false, code: 'INVALID_RESPONSE' }
    }
    emitDiagnostic(options, { code: 'READY', stage: 'planning', httpStatus: response.status })
    return { ok: true, plan, provider: 'deepseek' }
  } catch {
    const diagnosticCode = timedOut ? 'UPSTREAM_TIMEOUT' : 'NETWORK_UNAVAILABLE'
    emitDiagnostic(options, { code: diagnosticCode, stage: 'planning' })
    return { ok: false, code: mapDeepSeekDiagnosticToServiceCode(diagnosticCode) }
  } finally {
    clearTimeout(timeout)
  }
}
