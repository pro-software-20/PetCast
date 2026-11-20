import { ShellArtwork } from './ShellArtwork'
import { useEffect, useState } from 'react'
import './compact-quota.css'
import { getShell, getShellSize, shellScreenStyle } from '../appearance/shellRegistry'
import { PixelPet } from '../Pet'
import type { AppearancePreferences } from '../types/appearance'
import type { UsageState } from '../types/usage'
export type MainPage = 'home' | 'appearance' | 'tasks' | 'quota'
export function CompactDevice({ appearance, usage, status, stale, onNavigate, onClose, customPetImage }: {
  appearance: AppearancePreferences; usage: UsageState | null; status: string; stale: boolean;
  onNavigate: (page: MainPage) => void; onClose?: () => void; customPetImage?: string | null;
}) {
  const shell = getShell(appearance.shellId)
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 15000); return () => clearInterval(timer) }, [])
  const countdown = (date?: Date) => {
    if (!date || !Number.isFinite(date.getTime())) return '时间未知'
    if (stale) return '等待更新'
    const m = Math.ceil((date.getTime() - now) / 60000)
    if (m <= 0) return '等待确认重置'
    const d = Math.floor(m / 1440), h = Math.floor(m % 1440 / 60), minutes = m % 60
    return `${d ? `${d}天${h}小时` : h ? `${h}小时${minutes}分` : `${minutes}分钟`}后重置`
  }
  const resetTime = (date?: Date) => date && Number.isFinite(date.getTime()) ? `${date.getMonth()+1}/${date.getDate()} ${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}` : '—'
  const size = getShellSize(shell)
  const buttonStyle = (index: number) => ({ left: `${shell.buttons[index].left}%`, top: `${shell.buttons[index].top}%`, width: `${shell.buttons[index].size}%` })
  return <div className="compact-device-container">
    <div className="compact-device" aria-label={`${shell.name}拓麻歌子桌宠`} data-shell-id={shell.id} style={{ ...size, top: (340 - size.height) / 2 }}>
      <ShellArtwork shellId={shell.id} color={appearance.shellColor} />
      <div className={`device-screen ${stale ? 'is-stale' : ''}`} aria-label="正方形宠物与额度显示区" style={shellScreenStyle(shell)} title={status}>
        <div className="device-pet-viewport pet-wrap"><PixelPet petId={appearance.petId} name={appearance.petName} customPetImage={customPetImage} animated /></div>
        <div className="device-ring-quotas" aria-label="剩余额度与预计重置时间">
          {([['5h', usage?.shortWindowRemaining, usage?.shortWindowResetAt], ['周', usage?.weeklyRemaining, usage?.weeklyResetAt]] as const).map(([label, value, reset]) => <div className="device-ring-item" key={label}>
            <div className="device-quota-ring" style={{ background: `conic-gradient(#789861 ${value === undefined ? 0 : Math.max(0, Math.min(100, value)) * 3.6}deg, #dce4c8 0)` }}><div><strong>{value === undefined ? '—' : `${Math.round(value)}%`}</strong><span>{label}</span></div></div>
            <span className="device-reset-countdown">{countdown(reset)}</span><span className="device-reset-date" title="预计重置时间（本机时区）">{resetTime(reset)}</span>
          </div>)}
          {(!usage || stale) && <small role="status" style={{ display: 'block', fontSize: 11, lineHeight: 1.3 }}>{status}</small>}
        </div>
      </div>
      <button className="shell-button shell-home" style={buttonStyle(0)} onClick={() => onNavigate('home')} title="主页" aria-label="打开主页"><svg viewBox="0 0 20 20"><path d="M3 10 10 4l7 6M5 9v8h10V9M8 17v-5h4v5" /></svg></button>
      <button className="shell-button shell-appearance" style={buttonStyle(1)} onClick={() => onNavigate('appearance')} title="形象" aria-label="打开形象设置"><svg viewBox="0 0 20 20"><path d="m5 8 1-4 3 2h2l3-2 1 4M5 8v6c0 4 10 4 10 0V8M7 11h.1M13 11h.1M9 14h2" /></svg></button>
      <button className="shell-button shell-tasks" style={buttonStyle(2)} onClick={() => onNavigate('tasks')} title="任务分析" aria-label="打开任务分析"><svg viewBox="0 0 20 20"><path d="M5 3h7l3 3v11H5zM12 3v4h3M8 10h4M8 13h4" /></svg></button>
    </div>
    {onClose && <button className="close device-close" onClick={onClose} aria-label="关闭">×</button>}
  </div>
}
