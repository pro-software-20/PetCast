import {
  sanitizeTaskPlanningServiceResult,
  TASK_PLANNING_MAX_RESPONSE_BYTES,
  type TaskPlanningRequest,
  type TaskPlanningServiceResult,
} from './taskPlanningProtocol.js'

export interface TaskPlanningClientOptions {
  endpoint: string
  installId: string
  signal?: AbortSignal
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

const serviceUrl = (endpoint: string) => {
  try {
    const base = new URL(endpoint)
    const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)
    if (base.protocol !== 'https:' && !(base.protocol === 'http:' && isLoopback)) return null
    return new URL('/v1/task/plan', base).toString()
  } catch {
    return null
  }
}

export async function requestTaskPlan(
  input: TaskPlanningRequest,
  options: TaskPlanningClientOptions,
): Promise<TaskPlanningServiceResult> {
  const url = serviceUrl(options.endpoint)
  if (!url) return { ok: false, code: 'UPSTREAM_UNAVAILABLE' }

  const controller = new AbortController()
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, options.timeoutMs ?? 15_000)
  const abort = () => controller.abort()
  options.signal?.addEventListener('abort', abort, { once: true })

  try {
    const response = await (options.fetchImpl ?? fetch)(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-petcast-install-id': options.installId,
      },
      body: JSON.stringify(input),
      signal: controller.signal,
    })
    const declaredLength = Number(response.headers.get('content-length') ?? 0)
    if (Number.isFinite(declaredLength) && declaredLength > TASK_PLANNING_MAX_RESPONSE_BYTES) {
      return { ok: false, code: 'INVALID_RESPONSE' }
    }
    const text = await response.text()
    if (Buffer.byteLength(text) > TASK_PLANNING_MAX_RESPONSE_BYTES) {
      return { ok: false, code: 'INVALID_RESPONSE' }
    }
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      return { ok: false, code: 'INVALID_RESPONSE' }
    }
    const sanitized = sanitizeTaskPlanningServiceResult(value, input)
    if (!sanitized || (!response.ok && sanitized.ok)) return { ok: false, code: 'INVALID_RESPONSE' }
    return sanitized
  } catch {
    return { ok: false, code: timedOut ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNAVAILABLE' }
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', abort)
  }
}
