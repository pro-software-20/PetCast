import type { ReportQuery } from '../history/usageMetrics'
export interface ReportSettings { weekStart: number; weekEnd: number }
export const DEFAULT_SETTINGS: ReportSettings = {weekStart: 1, weekEnd: 0}
export const SETTINGS_KEY = 'petcast.report-settings.v2'
export function validateSettings(v: unknown): ReportSettings {
  const s = v as ReportSettings
  if (!s || ![s.weekStart, s.weekEnd].every(n => Number.isInteger(n) && n >= 0 && n <= 6)) throw Error('星期设置无效')
  return {weekStart: s.weekStart, weekEnd: s.weekEnd}
}
export function localDate(time: number, timeZone: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {timeZone, year:'numeric', month:'2-digit', day:'2-digit'}).formatToParts(time).map(p => [p.type,p.value]))
  return `${p.year}-${p.month}-${p.day}`
}
export function addDays(date: string, days: number) {
  const time = Date.parse(date+'T12:00:00.000Z')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(time) || new Date(time).toISOString().slice(0,10) !== date) throw Error('日期无效')
  return new Date(time + days*86400_000).toISOString().slice(0,10)
}
/** First instant of a civil day, including DST days that do not begin at 00:00. */
export function dayStart(date: string, zone: string): number {
  addDays(date, 0)
  const nominal = Date.parse(date+'T00:00:00.000Z')
  let lo = nominal-36*3600_000, hi = nominal+36*3600_000
  while (lo < hi) { const mid = Math.floor((lo+hi)/2); if (localDate(mid,zone) < date) lo=mid+1; else hi=mid }
  if (localDate(lo,zone) !== date) throw Error('该时区不存在此日期')
  return lo
}
export function calendarRange(kind: 'week'|'month', settings: ReportSettings, timeZone: string, anchor: string) {
  validateSettings(settings); addDays(anchor,0)
  if (kind === 'month') {
    const start = anchor.slice(0,7)+'-01', d = new Date(start+'T12:00:00Z')
    d.setUTCMonth(d.getUTCMonth()+1)
    return {start, end: addDays(d.toISOString().slice(0,10),-1)}
  }
  const weekday = new Date(anchor+'T12:00:00Z').getUTCDay()
  const start = addDays(anchor,-((weekday-settings.weekStart+7)%7))
  return {start, end: addDays(start,(settings.weekEnd-settings.weekStart+7)%7)}
}
export function calendarQuery(scope: Pick<ReportQuery,'source'|'scopeId'>, timeZone: string, start: string, end: string, now = Date.now()): ReportQuery {
  if (start > end) throw Error('开始日期不能晚于结束日期')
  const startMs=dayStart(start,timeZone), endMs=dayStart(addDays(end,1),timeZone)
  if (endMs-startMs > 93*86400_000) throw Error('一次报告最多选择 92 天')
  if (startMs >= now) throw Error('该区间尚未开始，请选择已有记录的日期')
  return {...scope,timeZone,startAt:new Date(startMs).toISOString(),endAt:new Date(Math.min(endMs,now)).toISOString()}
}
/** Compare to the same elapsed part of the previous calendar period; never compare a partial month to a full month. */
export function previousQuery(query: ReportQuery, kind: 'week'|'month'|'custom'): ReportQuery {
  const start = localDate(Date.parse(query.startAt),query.timeZone)
  let previousStart: number, previousEnd: number
  if (kind === 'month') {
    const d = new Date(start.slice(0,7)+'-01T12:00:00Z'); d.setUTCMonth(d.getUTCMonth()-1)
    previousStart = dayStart(d.toISOString().slice(0,10),query.timeZone)
    previousEnd = Date.parse(query.startAt)
  } else if (kind === 'week') {
    previousStart = dayStart(addDays(start,-7),query.timeZone)
    previousEnd = Date.parse(query.startAt)
  } else {
    previousEnd = Date.parse(query.startAt)
    previousStart = previousEnd - (Date.parse(query.endAt)-previousEnd)
  }
  const end = Math.min(previousEnd, previousStart+Date.parse(query.endAt)-Date.parse(query.startAt))
  return {...query,startAt:new Date(previousStart).toISOString(),endAt:new Date(end).toISOString()}
}
