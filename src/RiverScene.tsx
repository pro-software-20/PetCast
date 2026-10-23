import type { CSSProperties } from 'react'
import type { UsageAnalysis, UsageState } from './types/usage'
import type { AppearancePreferences } from './types/appearance'
import { UsageBoard } from './components/UsageBoard'
import { deriveRiverEnvironment } from './game/riverEnvironment'
import { RiverBackdrop } from './components/RiverBackdrop'
import { useLocalDayCycle } from './appearance/useLocalDayCycle'
import { Pet } from './Pet'
type RiverSceneProps = {
  usage: UsageState | null; analysis: UsageAnalysis | null; appearance: AppearancePreferences;
  onStartFishing: () => void; onOpenHome: () => void; onOpenMailbox: () => void;
  unreadMailCount: number; stale?: boolean; status?: string;
}
export function RiverScene({ usage, analysis, appearance, onStartFishing, onOpenHome, onOpenMailbox, unreadMailCount, stale = false, status }: RiverSceneProps) {
  const cycle = useLocalDayCycle()
  const environment = usage ? deriveRiverEnvironment(usage) : null
  const sceneStyle = { '--flow-duration': `${environment?.flowDurationSeconds ?? 9}s`, '--water-top': `${76 + ((environment?.waterTopPercent ?? 57) - 57) * .35}%` } as CSSProperties
  const shark = appearance.petId === 'shark'
  return <div className={`river-scene cartoon-river ${stale ? 'is-stale' : ''} ${!stale && analysis?.primary === 'freshReset' ? 'fresh-reset-river' : ''}`} style={sceneStyle} data-day-period={cycle.period} aria-label={`卡通河畔小屋，${usage ? `周额度水位${usage.weeklyRemaining}%` : '额度未知'}`}>
    <RiverBackdrop period={cycle.period} />
    <div className="cartoon-water" aria-hidden="true"><i className="water-ribbon ribbon-one" /><i className="water-ribbon ribbon-two" /><i className="water-ribbon ribbon-three" /></div>
    <div className="cottage-nameplate">{appearance.petName || '布罗艾'}的小屋</div>
    <button className="cottage-door" onClick={onOpenHome} aria-label="进入河边小屋"><span>进入小屋</span></button>
    <button className={`pixel-mailbox ${unreadMailCount ? 'has-mail' : ''}`} onClick={onOpenMailbox} aria-label={unreadMailCount ? `打开邮箱，有${unreadMailCount}封新消息` : '打开邮箱'}><i />{unreadMailCount > 0 && <b>{unreadMailCount}</b>}<span>邮箱</span></button>
    <div className={`river-pet-anchor ${shark ? 'pet-in-water' : 'pet-on-sand'}`} data-habitat={shark ? 'water' : 'sand'}>
      <Pet petId={appearance.petId} name={appearance.petName} dragging={false} expanded dragDirection="right" mood={stale ? 'normal' : analysis?.petMood ?? 'normal'} reaction={null} />
      {shark && <i className="pet-water-ripple" aria-hidden="true" />}
    </div>
    <button className="fishing-spot" disabled={stale || !usage} onClick={onStartFishing} aria-label="点击河面开始钓鱼"><i className="spot-ripple" /><span>{stale || !usage ? '等待额度更新' : '点击河面钓鱼'}</span></button>
    <div className="environment-readout" aria-label="河流环境状态"><div><span>流速</span><strong>{stale ? '等待更新' : environment?.flowLabel ?? '未知'}</strong></div><div><span>周水位</span><strong>{usage ? `${Math.round(usage.weeklyRemaining)}%` : '—'}</strong></div><div><span>时间</span><strong>{cycle.label}</strong></div></div>
    <div className="environment-key">{stale ? '当前额度未确认，暂停钓鱼与额度提醒' : '流速＝消耗速度 · 水位＝周额度剩余'}</div>
    <UsageBoard usage={usage} analysis={analysis} stale={stale} status={status} />
  </div>
}
