import { useState } from 'react'
import { PETS } from '../appearance/petRegistry'
import { SHELLS } from '../appearance/shellRegistry'
import { PixelPet } from '../Pet'
import { ShellArtwork } from './ShellArtwork'
import { ShellPreview } from './ShellPreview'
import { ColorPicker } from './ColorPicker'
import { normalizeAppearance, saveAppearance } from '../appearance/preferences'
import type { AppearancePreferences } from '../types/appearance'

export function AppearanceSettings({ value, onChange, onClose }: { value: AppearancePreferences; onChange: (value: AppearancePreferences) => void; onClose: () => void }) {
  const [status, setStatus] = useState('')
  const update = (patch: Partial<AppearancePreferences>) => { setStatus(''); onChange({ ...value, ...patch }) }
  const save = () => {
    try { onChange(saveAppearance(normalizeAppearance(value))); setStatus('设置已保存') }
    catch { setStatus('保存失败，请重试') }
  }
  return <section className="appearance-page" aria-label="形象设置">
    <div className="room-art" /><div className="room-nameplate">{value.petName || '布罗艾'}的小屋</div>
    <section className="appearance-preview"><span>当前形象</span><div className="appearance-preview-pet"><PixelPet petId={value.petId} name={value.petName} animated /></div><strong>{value.petName || '布罗艾'}</strong></section>
    <div className="appearance-frame"><div className="appearance-paper">
      <header><h1>形象设置</h1><button onClick={onClose} aria-label="关闭形象设置">×</button></header>
      <section className="pet-choice"><h2>形象选择</h2><div className="pet-choice-row">{PETS.map(pet => <button key={pet.id} aria-label={`选择${pet.name}`} aria-pressed={value.petId === pet.id} className={value.petId === pet.id ? 'selected' : ''} onClick={() => update({ petId: pet.id })}><span><PixelPet petId={pet.id} name={value.petName} /></span><strong>{pet.name}</strong>{value.petId === pet.id && <i className="selection-check">✓</i>}</button>)}</div></section>
      <section className="shell-choice"><h2>外观颜色</h2><div className="shell-settings-card">
        <section className="shell-settings-preview" aria-label="外壳实时预览与款式选择">
          <span>外壳实时预览</span>
          <div className="shell-preview-row"><div className="shell-live-preview"><ShellPreview shellId={value.shellId} color={value.shellColor} petId={value.petId} petName={value.petName} /></div>
            <div className="shell-choice-grid" aria-label="外壳款式">{SHELLS.map(shell => <button key={shell.id} className={value.shellId === shell.id ? 'selected' : ''} aria-label={`切换${shell.name}外壳`} aria-pressed={value.shellId === shell.id} onClick={() => update({ shellId: shell.id })}><ShellArtwork shellId={shell.id} color={value.shellColor} /><span>{shell.name}</span>{value.shellId === shell.id && <i className="selection-check">✓</i>}</button>)}</div>
          </div>
        </section>
        <ColorPicker value={value.shellColor} onChange={shellColor => update({ shellColor })} />
      </div></section>
      <footer className="appearance-footer"><label htmlFor="pet-name">姓名</label><input id="pet-name" value={value.petName} maxLength={16} onChange={e => update({ petName: e.target.value })} /><button className="save-appearance" onClick={save}>✓ 保存设置</button></footer>
      <span className="appearance-save-status" role="status">{status}</span>
    </div></div>
  </section>
}
