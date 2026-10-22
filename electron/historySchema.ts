/** Shared runtime validation for the browser store and the desktop IPC boundary. */
export const HISTORY_DAYS = 90
export const HISTORY_LIMIT = 100_000
const record = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw Error('历史数据格式无效')
  return v as Record<string, unknown>
}
export const iso = (v: unknown): string => {
  if (typeof v !== 'string' || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString() !== v) throw Error('历史时间格式无效')
  return v
}
export function validateHistoryScope(value: unknown): {source: 'real' | 'mock'; scopeId: string} {
  const v = record(value)
  if (v.source !== 'real' && v.source !== 'mock') throw Error('历史来源无效')
  if (typeof v.scopeId !== 'string' || !(v.source === 'real' ? /^codex-[a-f0-9]{64}$/ : /^mock-[a-z0-9-]{1,48}$/).test(v.scopeId)) throw Error('历史账号标识无效')
  return { source: v.source, scopeId: v.scopeId }
}
const percent = (v: unknown): number => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100) throw Error('历史额度无效')
  return v
}
export function validateHistorySample(value: unknown) {
  const v = record(value), scope = validateHistoryScope(v)
  if (typeof v.id !== 'string' || !/^[a-zA-Z0-9:._-]{1,160}$/.test(v.id)) throw Error('历史记录标识无效')
  if (v.burnRate !== null && (typeof v.burnRate !== 'number' || !Number.isFinite(v.burnRate) || v.burnRate < 0)) throw Error('历史速度无效')
  return { ...scope, id: v.id, sampledAt: iso(v.sampledAt), shortWindowRemaining: percent(v.shortWindowRemaining),
    weeklyRemaining: percent(v.weeklyRemaining), shortWindowResetAt: iso(v.shortWindowResetAt), weeklyResetAt: iso(v.weeklyResetAt), burnRate: v.burnRate }
}
export type HistorySample = ReturnType<typeof validateHistorySample>
export type HistoryScope = ReturnType<typeof validateHistoryScope>
export function validateHistoryQuery(value: unknown) {
  const v = record(value), scope = validateHistoryScope(v), startAt = iso(v.startAt), endAt = iso(v.endAt)
  if (startAt >= endAt || Date.parse(endAt) - Date.parse(startAt) > 366 * 86400_000) throw Error('历史查询范围无效')
  return { ...scope, startAt, endAt }
}
export type HistoryQuery = ReturnType<typeof validateHistoryQuery>
export function parseHistoryDocument(text: string): HistorySample[] {
  const doc = record(JSON.parse(text))
  if (doc.version !== 1 || !Array.isArray(doc.samples)) throw Error('历史文件版本或内容无效')
  return doc.samples.map(validateHistorySample)
}
export const sameScope = (a: HistoryScope, b: HistoryScope) => a.source === b.source && a.scopeId === b.scopeId
export function pruneHistory(samples: HistorySample[], now = Date.now()): HistorySample[] {
  const groups = new Map<string, Map<string, HistorySample>>()
  const cutoff = now - HISTORY_DAYS * 86400_000
  for (const sample of samples) {
    if (Date.parse(sample.sampledAt) < cutoff) continue
    const key = `${sample.source}:${sample.scopeId}`
    if (!groups.has(key)) groups.set(key, new Map())
    // Keep the first observation at this timestamp; a retry must not rewrite it.
    if (!groups.get(key)!.has(sample.sampledAt)) groups.get(key)!.set(sample.sampledAt, sample)
  }
  return [...groups.values()].flatMap(group => [...group.values()].sort((a,b) => a.sampledAt.localeCompare(b.sampledAt)).slice(-HISTORY_LIMIT))
}
export function selectHistory(samples: HistorySample[], query: HistoryQuery, now = Date.now()) {
  return pruneHistory(samples, now).filter(s => sameScope(s, query) && s.sampledAt >= query.startAt && s.sampledAt < query.endAt)
    .sort((a,b) => a.sampledAt.localeCompare(b.sampledAt))
}
export function appendHistory(samples: HistorySample[], sample: HistorySample, now = Date.now()) {
  if (Date.parse(sample.sampledAt) > now + 300_000) throw Error('历史采样时间超前，请检查系统时间')
  return pruneHistory([...samples, sample], now)
}
