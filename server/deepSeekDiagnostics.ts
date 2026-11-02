const DEEPSEEK_MODELS_URL = 'https://api.deepseek.com/models'
export const DEEPSEEK_DIAGNOSTIC_MAX_RESPONSE_BYTES = 256 * 1024

export type DeepSeekDiagnosticCode =
  | 'CONFIG_MISSING'
  | 'NETWORK_UNAVAILABLE'
  | 'AUTH_FAILED'
  | 'INSUFFICIENT_BALANCE'
  | 'RATE_LIMITED'
  | 'MODEL_UNAVAILABLE'
  | 'INVALID_REQUEST'
  | 'UPSTREAM_SERVER_ERROR'
  | 'UPSTREAM_TIMEOUT'
  | 'INVALID_RESPONSE'
  | 'READY'

export type DeepSeekDiagnosticStage = 'configuration' | 'models' | 'planning'

export interface DeepSeekDiagnosticResult {
  ready: boolean
  code: DeepSeekDiagnosticCode
  stage: DeepSeekDiagnosticStage
  checkedAt: string
  durationMs: number
  model: string
  httpStatus?: number
  retryAfterSeconds?: number
}

export interface DeepSeekDiagnosticEvent {
  code: DeepSeekDiagnosticCode
  stage: DeepSeekDiagnosticStage
  httpStatus?: number
  retryAfterSeconds?: number
}

export interface DeepSeekDiagnosticOptions {
  apiKey?: string
  model?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
  now?: () => Date
  monotonicNow?: () => number
}

interface DeepSeekModelsResponse {
  data?: Array<{ id?: unknown }>
}

const retryAfter = (response: Response) => {
  const seconds = Number(response.headers.get('retry-after'))
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : undefined
}

export function classifyDeepSeekHttpStatus(status: number): DeepSeekDiagnosticCode {
  if (status === 400 || status === 422) return 'INVALID_REQUEST'
  if (status === 401 || status === 403) return 'AUTH_FAILED'
  if (status === 402) return 'INSUFFICIENT_BALANCE'
  if (status === 408 || status === 504) return 'UPSTREAM_TIMEOUT'
  if (status === 429) return 'RATE_LIMITED'
  if (status >= 500) return 'UPSTREAM_SERVER_ERROR'
  return 'INVALID_RESPONSE'
}

export function mapDeepSeekDiagnosticToServiceCode(
  code: DeepSeekDiagnosticCode,
): 'INVALID_REQUEST' | 'RATE_LIMITED' | 'UPSTREAM_TIMEOUT' | 'UPSTREAM_UNAVAILABLE' | 'INVALID_RESPONSE' {
  if (code === 'INVALID_REQUEST') return 'INVALID_REQUEST'
  if (code === 'RATE_LIMITED') return 'RATE_LIMITED'
  if (code === 'UPSTREAM_TIMEOUT') return 'UPSTREAM_TIMEOUT'
  if (code === 'INVALID_RESPONSE' || code === 'MODEL_UNAVAILABLE') return 'INVALID_RESPONSE'
  return 'UPSTREAM_UNAVAILABLE'
}

const boundedBody = async (response: Response) => {
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (Number.isFinite(declared) && declared > DEEPSEEK_DIAGNOSTIC_MAX_RESPONSE_BYTES) return null
  const body = await response.text()
  return Buffer.byteLength(body) <= DEEPSEEK_DIAGNOSTIC_MAX_RESPONSE_BYTES ? body : null
}

export async function diagnoseDeepSeekUpstream(
  options: DeepSeekDiagnosticOptions,
): Promise<DeepSeekDiagnosticResult> {
  const model = options.model?.trim() || 'deepseek-flash'
  const checkedAt = (options.now ?? (() => new Date()))().toISOString()
  const clock = options.monotonicNow ?? (() => performance.now())
  const started = clock()
  const finish = (
    code: DeepSeekDiagnosticCode,
    stage: DeepSeekDiagnosticStage,
    extra: Pick<DeepSeekDiagnosticResult, 'httpStatus' | 'retryAfterSeconds'> = {},
  ): DeepSeekDiagnosticResult => ({
    ready: code === 'READY',
    code,
    stage,
    checkedAt,
    durationMs: Math.max(0, Math.round(clock() - started)),
    model,
    ...(extra.httpStatus === undefined ? {} : { httpStatus: extra.httpStatus }),
    ...(extra.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: extra.retryAfterSeconds }),
  })

  const apiKey = options.apiKey?.trim()
  if (!apiKey) return finish('CONFIG_MISSING', 'configuration')

  const controller = new AbortController()
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, options.timeoutMs ?? 15_000)

  try {
    const response = await (options.fetchImpl ?? fetch)(DEEPSEEK_MODELS_URL, {
      method: 'GET',
      headers: { authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    })
    if (!response.ok) {
      const code = classifyDeepSeekHttpStatus(response.status)
      return finish(code, 'models', {
        httpStatus: response.status,
        retryAfterSeconds: code === 'RATE_LIMITED' ? retryAfter(response) : undefined,
      })
    }

    const body = await boundedBody(response)
    if (body === null) return finish('INVALID_RESPONSE', 'models', { httpStatus: response.status })
    let payload: DeepSeekModelsResponse
    try {
      payload = JSON.parse(body) as DeepSeekModelsResponse
    } catch {
      return finish('INVALID_RESPONSE', 'models', { httpStatus: response.status })
    }
    if (!Array.isArray(payload.data)
      || payload.data.some(item => !item || typeof item !== 'object' || typeof item.id !== 'string')) {
      return finish('INVALID_RESPONSE', 'models', { httpStatus: response.status })
    }
    const models = payload.data.map(item => item.id as string)
    if (!models.includes(model)) return finish('MODEL_UNAVAILABLE', 'models', { httpStatus: response.status })
    return finish('READY', 'models', { httpStatus: response.status })
  } catch {
    return finish(timedOut ? 'UPSTREAM_TIMEOUT' : 'NETWORK_UNAVAILABLE', 'models')
  } finally {
    clearTimeout(timeout)
  }
}
