import { readFile } from 'node:fs/promises'

const MAX_CONFIG_BYTES = 4 * 1024
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

export interface AiServiceConfigOptions {
  configPath: string
  runtimeUrl?: string
  legacyRuntimeUrl?: string
  allowRuntimeOverride: boolean
  readFileImpl?: typeof readFile
}

export function normalizeAiServiceUrl(value: unknown, allowLoopbackHttp: boolean): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const url = new URL(value.trim())
    if (url.username || url.password || url.search || url.hash) return null
    const loopback = LOOPBACK_HOSTS.has(url.hostname)
    if (url.protocol !== 'https:' && !(allowLoopbackHttp && url.protocol === 'http:' && loopback)) return null
    return url.origin
  } catch {
    return null
  }
}

export async function resolveAiServiceUrl(options: AiServiceConfigOptions): Promise<string> {
  if (options.allowRuntimeOverride) {
    const explicit = options.runtimeUrl?.trim() || options.legacyRuntimeUrl?.trim()
    if (explicit) return normalizeAiServiceUrl(explicit, true) ?? ''
  }

  try {
    const raw = await (options.readFileImpl ?? readFile)(options.configPath)
    if (raw.byteLength > MAX_CONFIG_BYTES) return ''
    const value: unknown = JSON.parse(raw.toString('utf8'))
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return ''
    const record = value as Record<string, unknown>
    if (Object.keys(record).some(key => !['version', 'aiApiUrl'].includes(key))
      || record.version !== 1) return ''
    return normalizeAiServiceUrl(record.aiApiUrl, false) ?? ''
  } catch {
    return ''
  }
}
