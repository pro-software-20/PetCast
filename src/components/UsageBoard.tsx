import type { UsageAnalysis, UsageState } from '../types/usage'

type UsageBoardProps = {
  usage: UsageState | null
  analysis: UsageAnalysis | null
  compact?: boolean
  stale?: boolean
  status?: string
}

function QuotaBar({ label, value }: { label: string; value: number }) {
  const tone = value <= 15 ? 'critical' : value <= 30 ? 'low' : 'healthy'
  return (
    <div className={`quota-line tone-${tone}`}>
      <div className="quota-meta"><span>{label}</span><strong>{Math.round(value)}%</strong></div>
      <div className="quota-track"><i style={{ width: `${Math.max(0, value)}%` }} /></div>
    </div>
  )
}

export function UsageBoard({ usage, analysis, compact = false, stale = false, status }: UsageBoardProps) {
  if (!usage || !analysis) return <section className={compact ? 'usage-board usage-board-compact' : 'usage-board usage-board-detail'} aria-label="额度使用看板">
    <div className="usage-heading"><span>{status ?? '等待读取'}</span><strong>额度未知</strong></div>
    <div className="quota-meta"><span>5h / 本周</span><strong>— / —</strong></div>
    <p>请在额度设置中查看或重试</p>
  </section>
  return (
    <section className={compact ? 'usage-board usage-board-compact' : 'usage-board usage-board-detail'} aria-label="额度使用看板">
      <div className="usage-heading">
        <span>{stale ? '旧数据 · 暂停额度提醒' : analysis.weeklyPaceLabel}</span>
        <strong>{stale ? '上次读取结果' : analysis.headline}</strong>
      </div>
      <QuotaBar label="5h" value={usage.shortWindowRemaining} />
      <QuotaBar label="本周" value={usage.weeklyRemaining} />
      <div className="reset-line">
        <span>{stale ? `采样 ${usage.sampledAt.toLocaleTimeString('zh-CN')}` : `5h · ${analysis.shortResetText}`}</span>
        {!compact && !stale && <span>周 · {analysis.weeklyResetText}</span>}
      </div>
      {!compact && <p>{stale ? '当前余额未确认，请重新读取。' : analysis.message}</p>}
    </section>
  )
}
