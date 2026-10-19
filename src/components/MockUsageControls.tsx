import { useEffect, useState } from 'react'
import type { UsageScenarioId, UsageState } from '../types/usage'

type MockUsageControlsProps = {
  usage: UsageState
  onScenario: (scenario: UsageScenarioId) => void
  onPatch: (patch: Partial<UsageState>) => void
  onMockResetSignal: () => void
  resetWatchEnabled: boolean
  resetWatchNextAt: number | null
  resetCheckStatus: 'idle' | 'checking' | 'error'
  onToggleResetWatch: () => void
  autoFishingEnabled: boolean
  autoFishingNextAt: number | null
  onToggleAutoFishing: () => void
  onRunAutoFishing: () => void
  onClearCodexHistory: () => void
  saveStatus: 'loading' | 'saving' | 'saved' | 'error'
}

const scenarios: Array<{ id: UsageScenarioId; label: string }> = [
  { id: 'balanced', label: '平衡' },
  { id: 'shortPressure', label: '5h 紧张' },
  { id: 'weeklyPressure', label: '周紧张' },
  { id: 'resetSoon', label: '快重置' },
  { id: 'burst', label: '突然加速' },
  { id: 'freshReset', label: '刚重置' },
]

export function MockUsageControls({ usage, onScenario, onPatch, onMockResetSignal, resetWatchEnabled, resetWatchNextAt, resetCheckStatus, onToggleResetWatch, autoFishingEnabled, autoFishingNextAt, onToggleAutoFishing, onRunAutoFishing, onClearCodexHistory, saveStatus }: MockUsageControlsProps) {
  const [clock, setClock] = useState(Date.now())
  const [clearCodexArmed, setClearCodexArmed] = useState(false)
  const resetMinutes = Math.max(10, Math.round((usage.shortWindowResetAt.getTime() - Date.now()) / 60_000))
  const nextAutoSeconds = autoFishingNextAt ? Math.max(0, Math.ceil((autoFishingNextAt - clock) / 1_000)) : null
  const nextAutoLabel = nextAutoSeconds === null ? '已暂停' : `${Math.floor(nextAutoSeconds / 60)}:${String(nextAutoSeconds % 60).padStart(2, '0')}`
  const nextResetSeconds = resetWatchNextAt ? Math.max(0, Math.ceil((resetWatchNextAt - clock) / 1_000)) : null
  const nextResetLabel = nextResetSeconds === null ? '已暂停' : `${Math.floor(nextResetSeconds / 60)}:${String(nextResetSeconds % 60).padStart(2, '0')}`

  useEffect(() => {
    if (!autoFishingEnabled && !resetWatchEnabled) return
    const timer = window.setInterval(() => setClock(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [autoFishingEnabled, resetWatchEnabled])

  useEffect(() => {
    if (!clearCodexArmed) return
    const timer = window.setTimeout(() => setClearCodexArmed(false), 5_000)
    return () => window.clearTimeout(timer)
  }, [clearCodexArmed])

  const handleClearCodex = () => {
    if (!clearCodexArmed) {
      setClearCodexArmed(true)
      return
    }
    setClearCodexArmed(false)
    onClearCodexHistory()
  }

  return (
    <aside className="mock-controls" aria-label="额度控制台" onPointerDown={(event) => event.stopPropagation()}>
      <div className="mock-title"><span>QUOTA CONTROL</span><strong>额度状态控制</strong></div>
      <div className="scenario-grid">
        {scenarios.map((scenario) => (
          <button key={scenario.id} onClick={() => onScenario(scenario.id)}>{scenario.label}</button>
        ))}
      </div>
      <label>
        <span>5h 剩余 <b>{Math.round(usage.shortWindowRemaining)}%</b></span>
        <input type="range" min="0" max="100" value={usage.shortWindowRemaining} onChange={(event) => onPatch({ shortWindowRemaining: Number(event.target.value) })} />
      </label>
      <label>
        <span>周剩余 <b>{Math.round(usage.weeklyRemaining)}%</b></span>
        <input type="range" min="0" max="100" value={usage.weeklyRemaining} onChange={(event) => onPatch({ weeklyRemaining: Number(event.target.value) })} />
      </label>
      <label>
        <span>消耗速度 <b>{usage.burnRate.toFixed(1)}%/h</b></span>
        <input type="range" min="0" max="25" step="0.5" value={usage.burnRate} onChange={(event) => onPatch({ burnRate: Number(event.target.value) })} />
      </label>
      <label>
        <span>5h 距重置 <b>{resetMinutes} 分</b></span>
        <input
          type="range"
          min="10"
          max="300"
          step="5"
          value={Math.min(300, resetMinutes)}
          onChange={(event) => onPatch({ shortWindowResetAt: new Date(Date.now() + Number(event.target.value) * 60_000) })}
        />
      </label>
      <div className="stage-six-controls">
        <span>NOTIFICATIONS & FISHING</span>
        <div>
          <button className={resetWatchEnabled ? 'is-active' : ''} onClick={onToggleResetWatch}>{resetWatchEnabled ? '重置监测：开启' : '重置监测：关闭'}</button>
          <button className="mock-mail-button" onClick={onMockResetSignal} disabled={resetCheckStatus === 'checking'}>{resetCheckStatus === 'checking' ? '检查中…' : '检查动态'}</button>
          <button onClick={() => onPatch({ shortWindowResetAt: new Date(Date.now() - 1_000) })}>立即到点</button>
        </div>
        <small className={resetCheckStatus === 'error' ? 'is-error' : ''}>{resetCheckStatus === 'error' ? '检查失败 · 将自动重试' : `下次动态检查：${nextResetLabel}`}</small>
        <div>
          <button className={autoFishingEnabled ? 'is-active' : ''} onClick={onToggleAutoFishing}>
            {autoFishingEnabled ? '自动钓鱼：开启' : '自动钓鱼：关闭'}
          </button>
          <button onClick={onRunAutoFishing}>立即钓鱼</button>
        </div>
        <small>下次自动钓鱼：{nextAutoLabel}</small>
        <small className={`save-state save-${saveStatus}`}>
          {saveStatus === 'loading' ? '正在读取本地存档…' : saveStatus === 'saving' ? '正在保存…' : saveStatus === 'error' ? '本地存档暂时失败' : '本地存档：已保存'}
        </small>
        <button className={`clear-codex-button ${clearCodexArmed ? 'is-armed' : ''}`} onClick={handleClearCodex}>
          {clearCodexArmed ? '再次点击确认清空' : '清空鱼类图鉴历史'}
        </button>
      </div>
    </aside>
  )
}
