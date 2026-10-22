import { validateHistoryScope, type HistoryScope } from '../../electron/historySchema'
import type { ReportQuery } from './usageMetrics'
export function recommendationQuery(scope:HistoryScope,days:30|90,now=Date.now(),timeZone='UTC'):ReportQuery {
  const checked=validateHistoryScope(scope)
  if(![30,90].includes(days)||!Number.isFinite(now))throw Error('推荐历史范围无效')
  return {...checked,timeZone,startAt:new Date(now-days*86400000).toISOString(),endAt:new Date(now).toISOString()}
}
