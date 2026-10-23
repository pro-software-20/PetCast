import { createHmac } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

interface DailyCounters {
  global: number
  installs: Record<string, number>
  ips: Record<string, number>
}

interface PersistedState {
  days: Record<string, DailyCounters>
}

export interface AnonymousRateLimits {
  installPerMinute: number
  installPerDay: number
  ipPerMinute: number
  ipPerDay: number
  globalPerDay: number
}

export interface RateLimitDecision {
  allowed: boolean
  retryAfterSeconds?: number
}

export const DEFAULT_ANONYMOUS_RATE_LIMITS: AnonymousRateLimits = {
  installPerMinute: 5,
  installPerDay: 50,
  ipPerMinute: 20,
  ipPerDay: 200,
  globalPerDay: 1_000,
}

const emptyState = (): PersistedState => ({ days: {} })
const dayKey = (now: Date) => now.toISOString().slice(0, 10)
const secondsToNextDay = (now: Date) => Math.max(1, Math.ceil((Date.UTC(
  now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1,
) - now.getTime()) / 1_000))

export class AnonymousRateLimiter {
  private state: PersistedState = emptyState()
  private loaded = false
  private minuteCounters = new Map<string, number>()
  private operation = Promise.resolve<unknown>(undefined)

  constructor(
    private readonly secret: string,
    private readonly statePath: string,
    private readonly limits: AnonymousRateLimits = DEFAULT_ANONYMOUS_RATE_LIMITS,
  ) {
    if (secret.length < 32) throw new Error('RATE_LIMIT_HASH_SECRET must contain at least 32 characters')
    for (const value of Object.values(limits)) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Rate limits must be positive integers')
    }
  }

  consume(installId: string, ip: string, now = new Date()): Promise<RateLimitDecision> {
    const pending = this.operation.then(() => this.consumeSerial(installId, ip, now))
    this.operation = pending.catch(() => undefined)
    return pending
  }

  private hash(value: string) {
    return createHmac('sha256', this.secret).update(value).digest('hex')
  }

  private async load() {
    if (this.loaded) return
    this.loaded = true
    try {
      const parsed = JSON.parse(await fs.readFile(this.statePath, 'utf8')) as PersistedState
      if (parsed && typeof parsed === 'object' && parsed.days && typeof parsed.days === 'object') {
        this.state = parsed
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.state = emptyState()
    }
  }

  private prune(now: Date) {
    const cutoff = now.getTime() - 48 * 60 * 60 * 1_000
    for (const key of Object.keys(this.state.days)) {
      if (new Date(`${key}T00:00:00.000Z`).getTime() < cutoff) delete this.state.days[key]
    }
    const currentMinute = Math.floor(now.getTime() / 60_000)
    for (const key of this.minuteCounters.keys()) {
      const minute = Number(key.slice(key.lastIndexOf(':') + 1))
      if (minute < currentMinute - 1) this.minuteCounters.delete(key)
    }
  }

  private async persist() {
    await fs.mkdir(path.dirname(this.statePath), { recursive: true })
    const temporary = `${this.statePath}.${process.pid}.tmp`
    await fs.writeFile(temporary, JSON.stringify(this.state), 'utf8')
    await fs.rename(temporary, this.statePath)
  }

  private async consumeSerial(installId: string, ip: string, now: Date): Promise<RateLimitDecision> {
    await this.load()
    this.prune(now)
    const day = dayKey(now)
    const counters = this.state.days[day] ??= { global: 0, installs: {}, ips: {} }
    const installHash = this.hash(`install:${installId}`)
    const ipHash = this.hash(`ip:${ip}`)
    const minute = Math.floor(now.getTime() / 60_000)
    const installMinuteKey = `install:${installHash}:${minute}`
    const ipMinuteKey = `ip:${ipHash}:${minute}`
    const installMinute = this.minuteCounters.get(installMinuteKey) ?? 0
    const ipMinute = this.minuteCounters.get(ipMinuteKey) ?? 0

    if (installMinute >= this.limits.installPerMinute || ipMinute >= this.limits.ipPerMinute) {
      return { allowed: false, retryAfterSeconds: 60 - now.getUTCSeconds() }
    }
    if ((counters.installs[installHash] ?? 0) >= this.limits.installPerDay
      || (counters.ips[ipHash] ?? 0) >= this.limits.ipPerDay
      || counters.global >= this.limits.globalPerDay) {
      return { allowed: false, retryAfterSeconds: secondsToNextDay(now) }
    }

    this.minuteCounters.set(installMinuteKey, installMinute + 1)
    this.minuteCounters.set(ipMinuteKey, ipMinute + 1)
    counters.installs[installHash] = (counters.installs[installHash] ?? 0) + 1
    counters.ips[ipHash] = (counters.ips[ipHash] ?? 0) + 1
    counters.global += 1
    await this.persist()
    return { allowed: true }
  }
}
