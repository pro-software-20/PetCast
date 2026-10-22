import type { CodexQuotaDiagnostics } from './codexProtocol.js'

const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
const plans = new Set(['free', 'plus', 'pro', 'team', 'business', 'enterprise', 'edu'])

export function createCodexDiagnostics(accountValue: unknown, limitsValue: unknown,
  executableSource: CodexQuotaDiagnostics['executableSource'], customHome: boolean): CodexQuotaDiagnostics {
  const account = object(object(accountValue).account), limits = object(limitsValue)
  const email = typeof account.email === 'string' ? account.email.trim().toLowerCase() : ''
  // Reveal only the first character of the local and domain parts, never full address/domain.
  const match = /^([a-z0-9])[^@\s]*@([a-z0-9])[^@\s]*$/.exec(email)
  const accountLabel = match ? `${match[1]}***@${match[2]}***` : null
  const entries = limits.rateLimitsByLimitId == null
    ? [['codex', limits.rateLimits]] as Array<[string, unknown]>
    : Object.entries(object(limits.rateLimitsByLimitId))
  return {
    accountLabel,
    planType: plans.has(String(account.planType)) ? account.planType as CodexQuotaDiagnostics['planType'] : 'unknown',
    executableSource, customHome, workspaceIdentified: typeof limits.accountId === 'string' && !!limits.accountId.trim(), selectedBucket: 'codex',
    buckets: entries.filter(([id]) => /^[a-zA-Z0-9_.-]{1,80}$/.test(id)).slice(0,32).map(([id, value]) => {
      const bucket = object(value)
      return { id, windows: [bucket.primary, bucket.secondary].filter(v => v != null).map(value => {
        const w = object(value)
        const reset = typeof w.resetsAt === 'number' && Number.isSafeInteger(w.resetsAt) && w.resetsAt > 0
          ? new Date(w.resetsAt * 1000) : null
        return {
          minutes: typeof w.windowDurationMins === 'number' && Number.isSafeInteger(w.windowDurationMins) && w.windowDurationMins > 0 ? w.windowDurationMins : null,
          usedPercent: typeof w.usedPercent === 'number' && Number.isFinite(w.usedPercent) && w.usedPercent >= 0 ? w.usedPercent : null,
          resetsAt: reset && Number.isFinite(+reset) ? reset.toISOString() : null,
        }
      }) }
    }),
  }
}

/** Reconstruct allowed fields instead of retaining mutable or extra bridge fields. */
export function copyCodexDiagnostics(value: unknown): CodexQuotaDiagnostics | undefined {
  if (value === undefined) return undefined
  const d = object(value)
  if (!(d.accountLabel === null || typeof d.accountLabel === 'string' && /^[a-z0-9]\*{3}@[a-z0-9]\*{3}$/.test(d.accountLabel))
    || ![...plans, 'unknown'].includes(String(d.planType))
    || !['override','path','desktop','explicit'].includes(String(d.executableSource))
    || typeof d.customHome !== 'boolean' || typeof d.workspaceIdentified !== 'boolean'
    || d.selectedBucket !== 'codex' || !Array.isArray(d.buckets) || d.buckets.length > 32) throw Error('Invalid diagnostics')
  const buckets = d.buckets.map(value => {
    const b = object(value)
    if (typeof b.id !== 'string' || !/^[a-zA-Z0-9_.-]{1,80}$/.test(b.id) || !Array.isArray(b.windows) || b.windows.length > 2) throw Error('Invalid diagnostics')
    const windows = b.windows.map(value => {
      const w = object(value)
      if (!(w.minutes === null || typeof w.minutes === 'number' && Number.isSafeInteger(w.minutes) && w.minutes > 0)
        || !(w.usedPercent === null || typeof w.usedPercent === 'number' && Number.isFinite(w.usedPercent) && w.usedPercent >= 0)
        || !(w.resetsAt === null || typeof w.resetsAt === 'string' && Number.isFinite(Date.parse(w.resetsAt)) && new Date(w.resetsAt).toISOString() === w.resetsAt)) throw Error('Invalid diagnostics')
      return { minutes: w.minutes, usedPercent: w.usedPercent, resetsAt: w.resetsAt }
    })
    return { id: b.id, windows }
  })
  return { accountLabel: d.accountLabel, planType: d.planType, executableSource: d.executableSource,
    customHome: d.customHome, workspaceIdentified: d.workspaceIdentified, selectedBucket: 'codex', buckets } as CodexQuotaDiagnostics
}
