import type { UsageAnalysis, UsageState } from '../types/usage'

type UsageBoardProps = {
  usage: UsageState
  analysis: UsageAnalysis
  compact?: boolean
}

function QuotaBar({ label, value }: { label: string; value: number }) {
  const tone = value <= 15 ? 'critical' : value <= 30 ? 'low' : 'healthy'
  return (
    <div className={`quota-line tone-${tone}`}>
      <div className="quota-meta"><span>{label}</span><strong>{Math.round(value)}%</strong></div>
      <div className="quota-track"><i style={{ width: `${Math.max(2, value)}%` }} /></div>
    </div>
  )
}

export function UsageBoard({ usage, analysis, compact = false }: UsageBoardProps) {
  return (
    <section className={compact ? 'usage-board usage-board-compact' : 'usage-board usage-board-detail'} aria-label="额度使用看板">
      <div className="usage-heading">
        <span>{analysis.weeklyPaceLabel}</span>
        <strong>{analysis.headline}</strong>
      </div>
      <QuotaBar label="5h" value={usage.shortWindowRemaining} />
      <QuotaBar label="本周" value={usage.weeklyRemaining} />
      <div className="reset-line">
        <span>5h · {analysis.shortResetText}</span>
        {!compact && <span>周 · {analysis.weeklyResetText}</span>}
      </div>
      {!compact && <p>{analysis.message}</p>}
    </section>
  )
}
