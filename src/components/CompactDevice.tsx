import { ShellArtwork } from './ShellArtwork'
import { getShell, getShellSize, shellScreenStyle } from '../appearance/shellRegistry'
import { PixelPet } from '../Pet'
import type { AppearancePreferences } from '../types/appearance'
import type { UsageState } from '../types/usage'
export type MainPage = 'home' | 'appearance' | 'tasks' | 'quota'
export function CompactDevice({ appearance, usage, status, stale, onNavigate, onClose }: {
  appearance: AppearancePreferences; usage: UsageState | null; status: string; stale: boolean;
  onNavigate: (page: MainPage) => void; onClose?: () => void;
}) {
  const shell = getShell(appearance.shellId)
  const size = getShellSize(shell)
  const buttonStyle = (index: number) => ({ left: `${shell.buttons[index].left}%`, top: `${shell.buttons[index].top}%`, width: `${shell.buttons[index].size}%` })
  return <div className="compact-device-container">
    <div className="compact-device" aria-label={`${shell.name}拓麻歌子桌宠`} data-shell-id={shell.id} style={{ ...size, top: (340 - size.height) / 2 }}>
      <ShellArtwork shellId={shell.id} color={appearance.shellColor} />
      <div className={`device-screen ${stale ? 'is-stale' : ''}`} aria-label="正方形宠物与额度显示区" style={shellScreenStyle(shell)} title={status}>
        <span className="device-source">{status}</span>
        <div className="device-pet-viewport pet-wrap"><PixelPet petId={appearance.petId} name={appearance.petName} animated /></div>
        <div className="device-quotas" aria-label={`${status}，5h ${usage ? Math.round(usage.shortWindowRemaining) + '%' : '未知'}，周额度 ${usage ? Math.round(usage.weeklyRemaining) + '%' : '未知'}`}>
          {([['5h', usage?.shortWindowRemaining], ['周', usage?.weeklyRemaining]] as const).map(([label, value]) => <div className="device-quota-row" key={label}>
            <span>{label}</span><div className="device-quota-track"><i style={{ width: value === undefined ? '0%' : `${Math.max(0, Math.min(100, value))}%` }} /></div><strong>{value === undefined ? '—' : `${Math.round(value)}%`}</strong>
          </div>)}
        </div>
      </div>
      <button className="shell-button shell-home" style={buttonStyle(0)} onClick={() => onNavigate('home')} title="主页" aria-label="打开主页"><svg viewBox="0 0 20 20"><path d="M3 10 10 4l7 6M5 9v8h10V9M8 17v-5h4v5" /></svg></button>
      <button className="shell-button shell-appearance" style={buttonStyle(1)} onClick={() => onNavigate('appearance')} title="形象" aria-label="打开形象设置"><svg viewBox="0 0 20 20"><path d="m5 8 1-4 3 2h2l3-2 1 4M5 8v6c0 4 10 4 10 0V8M7 11h.1M13 11h.1M9 14h2" /></svg></button>
      <button className="shell-button shell-tasks" style={buttonStyle(2)} onClick={() => onNavigate('tasks')} title="任务分析" aria-label="打开任务分析"><svg viewBox="0 0 20 20"><path d="M5 3h7l3 3v11H5zM12 3v4h3M8 10h4M8 13h4" /></svg></button>
    </div>
    {onClose && <button className="close device-close" onClick={onClose} aria-label="关闭">×</button>}
  </div>
}
