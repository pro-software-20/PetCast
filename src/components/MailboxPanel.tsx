import { useEffect, useState } from 'react'
import { FISH_SPECIES } from '../game/fishSpecies'
import { formatResetStatus } from '../game/usageAnalysis'
import type { MailItem } from '../types/notifications'
import type { UsageState } from '../types/usage'

type MailboxPanelProps = {
  items: MailItem[]
  usage: UsageState | null
  onClose: () => void
}

const timeLabel = (iso: string) => new Date(iso).toLocaleString('zh-CN', {
  month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
})

const signalUsageContext = (item: Extract<MailItem, { type: 'resetSignal' }>, usage: UsageState | null, now: Date) => {
  if (!usage) return { label: '当前额度', remaining: '未知', resetText: '待确认', verdict: '当前无有效额度，无法核对这条历史线索。' }
  const isShortWindow = item.resetType === 'short'
  const remaining = isShortWindow ? usage.shortWindowRemaining : usage.weeklyRemaining
  const resetAt = isShortWindow ? usage.shortWindowResetAt : usage.weeklyResetAt
  const minutesUntilReset = Math.max(0, Math.round((resetAt.getTime() - now.getTime()) / 60_000))
  const pending = +resetAt <= +now
  const isNearReset = !pending && minutesUntilReset <= (isShortWindow ? 45 : 12 * 60)
  const isLow = remaining <= (isShortWindow ? 25 : 22)

  let verdict = '当前额度仍可使用，这条消息只作为提前预告。'
  if (pending) verdict = '已到预计时间，尚未确认额度恢复，请重新读取。'
  else if (isNearReset) verdict = '外部线索与当前倒计时接近，建议稍后再次确认额度。'
  else if (isLow) verdict = '额度已经进入低位，但重置时间仍以额度页面为准。'

  return {
    label: isShortWindow ? '5h 额度' : '周额度',
    remaining: `${remaining}%`,
    resetText: formatResetStatus(resetAt, now),
    verdict,
  }
}

export function MailboxPanel({ items, usage, onClose }: MailboxPanelProps) {
  const [filter, setFilter] = useState<'all' | 'reset' | 'autoFishing'>('all')
  const [now, setNow] = useState(() => new Date())
  const visibleItems = filter === 'all'
    ? items
    : items.filter((item) => filter === 'reset' ? item.type !== 'autoFishing' : item.type === filter)
  const resetCount = items.filter((item) => item.type !== 'autoFishing').length
  const fishingCount = items.filter((item) => item.type === 'autoFishing').length

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  return (
    <section className="mailbox-panel" role="dialog" aria-label="河边邮箱">
      <header>
        <div><span>RIVERSIDE MAIL</span><strong>布罗艾的邮箱</strong></div>
        <button autoFocus onClick={onClose} aria-label="关闭邮箱">×</button>
      </header>
      <div className="mailbox-disclaimer">邮箱保留历史记录，模拟线索仅供演示；当前额度以最新读取为准。</div>
      <nav className="mail-filters" aria-label="邮箱分类">
        <button className={filter === 'all' ? 'is-active' : ''} onClick={() => setFilter('all')}>全部 {items.length}</button>
        <button className={filter === 'reset' ? 'is-active' : ''} onClick={() => setFilter('reset')}>重置消息 {resetCount}</button>
        <button className={filter === 'autoFishing' ? 'is-active' : ''} onClick={() => setFilter('autoFishing')}>钓鱼报告 {fishingCount}</button>
      </nav>
      <div className="mail-list">
        {visibleItems.length === 0 && (
          <div className="mail-empty"><i>✉</i><strong>邮箱还是空的</strong><span>收到重置线索或自动钓鱼报告后会出现在这里。</span></div>
        )}
        {visibleItems.map((item) => item.type === 'resetSignal' ? (() => {
          const context = signalUsageContext(item, usage, now)
          return (
            <article className="mail-card reset-mail" key={item.id}>
              <div className="mail-icon">𝕏</div>
              <div className="mail-content">
                <span>{item.author} · {item.handle}<time>{timeLabel(item.publishedAt)}</time></span>
                <strong>{item.resetType === 'short' ? '5h 额度可能正在重置' : '周额度可能正在重置'}</strong>
                <p>{item.text}</p>
                <div className="signal-check" aria-label="当前额度核对">
                  <div><span>{context.label}剩余</span><b>{context.remaining}</b></div>
                  <div><span>预计恢复</span><b>{context.resetText}</b></div>
                  <p>{context.verdict}</p>
                </div>
                <footer>
                  <b>{item.confidence === 'likely' ? '较强信号' : '可能信号'}</b>
                  <em>{item.sourceLabel}</em>
                  <a href={item.sourceUrl} target="_blank" rel="noreferrer" aria-label="在浏览器打开 X 原帖">查看 X 原帖 ↗</a>
                </footer>
              </div>
            </article>
          )
        })() : item.type === 'resetCompleted' ? (
          <article className="mail-card completed-mail" key={item.id}>
            <div className="mail-icon">✓</div>
            <div className="mail-content">
              <span>{item.source === 'mock' ? '模拟重置记录' : item.source === 'real' ? '真实额度历史记录' : '历史记录（来源未标记）'}<time>{timeLabel(item.createdAt)}</time></span>
              <strong>{item.resetType === 'short' ? '5h 额度已经恢复' : '周额度已经恢复'}</strong>
              <p>{item.resetType === 'short'
                ? '当时观测到 5h 额度恢复。执行新任务前需核对最新的两个窗口余额。'
                : '当时观测到周额度恢复。执行新任务前需核对最新的两个窗口余额。'}</p>
              <footer><b>历史事件</b><em>不代表当前余额</em></footer>
            </div>
          </article>
        ) : (
          <article className="mail-card auto-mail" key={item.id}>
            <div className="mail-icon">🎣</div>
            <div className="mail-content">
              <span>布罗艾自动钓鱼报告<time>{timeLabel(item.createdAt)}</time></span>
              <strong>自动钓到了 {item.fish.length} 条鱼，其中 {item.newSpeciesIds.length} 条是新鱼！</strong>
              <div className="mail-fish-list">
                {item.fish.map((fish, index) => {
                  const species = FISH_SPECIES.find((candidate) => candidate.id === fish.speciesId)
                  return <i key={`${fish.speciesId}-${index}`} style={{ '--mail-fish': species?.bodyColor ?? '#79acc4' } as React.CSSProperties}>{fish.name} · {fish.length.toFixed(1)}cm</i>
                })}
              </div>
              <footer><b>图鉴已更新</b><em>自动捕获后已放生，不占用水族箱</em></footer>
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}
