import { useEffect } from 'react'
import type { UsageConnectionState, UsageSource } from '../usage/UsageConnection'

export function usageStatus(state: UsageConnectionState) {
  const source = state.source === 'real' ? '真实额度' : '模拟数据'
  if (!state.reading) return `${source} · ${state.refreshing ? '读取中' : '等待读取'}`
  if (state.reading.status === 'unavailable') return `${source} · 不可用`
  if (state.reading.status === 'stale') return `${source} · 旧数据`
  return `${source}${state.refreshing ? ' · 刷新中' : ''}`
}

export function UsageSettings({ state, desktop, onSelect, onRefresh, onClose }: {
  state: UsageConnectionState
  desktop: boolean
  onSelect: (source: UsageSource) => void
  onRefresh: () => void
  onClose?: () => void
}) {
  useEffect(() => {
    if (!onClose) return
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [onClose])
  const reading = state.reading
  const usage = reading?.data
  return (
    <section className="usage-settings" role={onClose ? "dialog" : "region"} aria-label="额度数据设置" onPointerDown={event => event.stopPropagation()}>
      <header><strong>额度数据</strong>{onClose && <button autoFocus onClick={onClose} aria-label="关闭额度设置">×</button>}</header>
      <div className="source-options" role="group" aria-label="额度来源">
        <button aria-pressed={state.source === 'real'} onClick={() => onSelect('real')}>真实额度</button>
        <button aria-pressed={state.source === 'mock'} onClick={() => onSelect('mock')}>模拟演示</button>
      </div>
      <p className="source-explanation">{state.source === 'mock'
        ? '演示数据，可在河边控制台调整。'
        : '读取此电脑上已登录的 Codex 账号。'}</p>
      <div className={`usage-read-feedback feedback-${reading?.status ?? 'loading'}`} role="status">
        <strong>{usageStatus(state)}</strong>
        {state.source === 'real' && !desktop
          ? <p>浏览器无法读取本机 Codex。请打开桌面版，或选择模拟演示。</p>
          : reading?.error && <p>{reading.error}</p>}
        {reading?.status === 'stale' && <p>以下余额为上次读取结果，额度提醒与自动钓鱼已暂停。</p>}
        {usage && <p className="sample-time">采样：{usage.sampledAt.toLocaleString('zh-CN')}</p>}
      </div>
      <button className="usage-refresh" disabled={state.refreshing} onClick={onRefresh}>
        {state.refreshing ? '正在读取…' : '重新读取'}
      </button>
      {usage && <div className="usage-settings-values">
        <span>5h 剩余 <b>{Math.round(usage.shortWindowRemaining)}%</b></span>
        <span>周剩余 <b>{Math.round(usage.weeklyRemaining)}%</b></span>
        <span>消耗速度 <b>{usage.burnRate === null ? '数据不足' : `${usage.burnRate.toFixed(1)} 百分点/小时`}</b></span>
      </div>}
    </section>
  )
}
