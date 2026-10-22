import type { UsageSample } from '../types/usageHistory'
import type { ReportQuery } from '../history/usageMetrics'
import { weeklyReport } from './weeklyReport'
export const monthlyReport = (samples: UsageSample[], query: ReportQuery) => weeklyReport(samples, query)
/** Opt-in preview only. These samples are never appended to any history store. */
export function createMonthlyDemo(now = new Date()): UsageSample[] {
  const samples: UsageSample[] = []
  for (let day = 29; day >= 0; day--) {
    const start = now.getTime() - day * 86400_000 - 4 * 3600_000
    for (let i = 0; i < 31; i++) {
      samples.push({id: `demo-${day}-${i}`, source: 'mock', scopeId: 'mock-demo', sampledAt: new Date(start+i*180_000).toISOString(),
        shortWindowRemaining: 80 - i*(day % 3 + 1)*.7, weeklyRemaining: 65-i*.2,
        shortWindowResetAt: new Date(start+5*3600_000).toISOString(), weeklyResetAt: new Date(start+7*86400_000).toISOString(), burnRate: null})
    }
  }
  return samples
}
