import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  PROMPT_OPTIMIZATION_MAX_BODY_BYTES,
  sanitizePromptOptimizationRequest,
  type PromptOptimizationRequest,
  type PromptOptimizationResult,
} from '../electron/promptOptimizationProtocol.js'
import {
  AnonymousRateLimiter,
  DEFAULT_ANONYMOUS_RATE_LIMITS,
  type AnonymousRateLimits,
  type RateLimitDecision,
} from './anonymousRateLimiter.js'
import { optimizePromptWithDeepSeek } from './deepSeekPromptOptimizer.js'

const INSTALL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

interface RateLimiterLike {
  consume(installId: string, ip: string, now?: Date): Promise<RateLimitDecision>
}

export interface PromptOptimizationServerOptions {
  limiter: RateLimiterLike
  optimize(input: PromptOptimizationRequest): Promise<PromptOptimizationResult>
  trustProxy?: boolean
}

const sendJson = (response: ServerResponse, status: number, value: unknown) => {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(JSON.stringify(value))
}

const readBody = async (request: IncomingMessage) => {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > PROMPT_OPTIMIZATION_MAX_BODY_BYTES) throw new Error('BODY_TOO_LARGE')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

const clientIp = (request: IncomingMessage, trustProxy: boolean) => {
  if (trustProxy) {
    const forwarded = request.headers['x-forwarded-for']
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim()
    if (first && first.length <= 128) return first
  }
  return request.socket.remoteAddress ?? 'unknown'
}

const statusFor = (result: PromptOptimizationResult) => {
  if (result.ok) return 200
  if (result.code === 'INVALID_REQUEST') return 400
  if (result.code === 'RATE_LIMITED') return 429
  if (result.code === 'UPSTREAM_TIMEOUT') return 504
  return 502
}

export function createPromptOptimizationServer(options: PromptOptimizationServerOptions) {
  return createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      sendJson(response, 200, { ok: true })
      return
    }
    if (request.method !== 'POST' || request.url !== '/v1/prompt/optimize') {
      sendJson(response, 404, { ok: false, code: 'INVALID_REQUEST' })
      return
    }

    const installHeader = request.headers['x-petcast-install-id']
    const installId = Array.isArray(installHeader) ? installHeader[0] : installHeader
    if (!installId || !INSTALL_ID_PATTERN.test(installId)) {
      sendJson(response, 400, { ok: false, code: 'INVALID_REQUEST' })
      return
    }

    let input: unknown
    try {
      input = JSON.parse(await readBody(request))
    } catch {
      sendJson(response, 400, { ok: false, code: 'INVALID_REQUEST' })
      return
    }
    const sanitized = sanitizePromptOptimizationRequest(input)
    if (!sanitized) {
      sendJson(response, 400, { ok: false, code: 'INVALID_REQUEST' })
      return
    }

    try {
      const decision = await options.limiter.consume(installId, clientIp(request, options.trustProxy ?? false))
      if (!decision.allowed) {
        sendJson(response, 429, {
          ok: false,
          code: 'RATE_LIMITED',
          retryAfterSeconds: decision.retryAfterSeconds,
        })
        return
      }
      const result = await options.optimize(sanitized)
      sendJson(response, statusFor(result), result)
    } catch {
      sendJson(response, 502, { ok: false, code: 'UPSTREAM_UNAVAILABLE' })
    }
  })
}

const positiveInteger = (value: string | undefined, fallback: number) => {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`Invalid positive integer: ${value}`)
  return parsed
}

const limitsFromEnvironment = (): AnonymousRateLimits => ({
  installPerMinute: positiveInteger(process.env.PROMPT_LIMIT_INSTALL_MINUTE, DEFAULT_ANONYMOUS_RATE_LIMITS.installPerMinute),
  installPerDay: positiveInteger(process.env.PROMPT_LIMIT_INSTALL_DAY, DEFAULT_ANONYMOUS_RATE_LIMITS.installPerDay),
  ipPerMinute: positiveInteger(process.env.PROMPT_LIMIT_IP_MINUTE, DEFAULT_ANONYMOUS_RATE_LIMITS.ipPerMinute),
  ipPerDay: positiveInteger(process.env.PROMPT_LIMIT_IP_DAY, DEFAULT_ANONYMOUS_RATE_LIMITS.ipPerDay),
  globalPerDay: positiveInteger(process.env.PROMPT_LIMIT_GLOBAL_DAY, DEFAULT_ANONYMOUS_RATE_LIMITS.globalPerDay),
})

export function startPromptOptimizationServer() {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim()
  const rateLimitSecret = process.env.RATE_LIMIT_HASH_SECRET?.trim()
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY is required')
  if (!rateLimitSecret || rateLimitSecret.length < 32) {
    throw new Error('RATE_LIMIT_HASH_SECRET with at least 32 characters is required')
  }
  const port = positiveInteger(process.env.PORT, 8787)
  const host = process.env.HOST?.trim() || '127.0.0.1'
  const statePath = process.env.PROMPT_RATE_LIMIT_STATE_PATH?.trim()
    || path.join(process.cwd(), 'work', 'prompt-rate-limits.json')
  const limiter = new AnonymousRateLimiter(rateLimitSecret, statePath, limitsFromEnvironment())
  const server = createPromptOptimizationServer({
    limiter,
    trustProxy: process.env.PETCAST_TRUST_PROXY === '1',
    optimize: input => optimizePromptWithDeepSeek(input, {
      apiKey,
      model: process.env.DEEPSEEK_MODEL?.trim() || 'deepseek-flash',
    }),
  })
  server.listen(port, host, () => {
    console.log(`PetCast prompt service listening on http://${host}:${port}`)
  })
  return server
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : ''
if (entry === import.meta.url) {
  try {
    startPromptOptimizationServer()
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Prompt service failed to start')
    process.exitCode = 1
  }
}
