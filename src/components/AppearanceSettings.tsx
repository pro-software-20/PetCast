import { useRef, useState } from 'react'
import { CUSTOM_PET_ID, PETS } from '../appearance/petRegistry'
import { SHELLS } from '../appearance/shellRegistry'
import { PixelPet } from '../Pet'
import { ShellArtwork } from './ShellArtwork'
import { ShellPreview } from './ShellPreview'
import { ColorPicker } from './ColorPicker'
import { normalizeAppearance, saveAppearance } from '../appearance/preferences'
import type { AppearancePreferences } from '../types/appearance'
import type { CustomPetAsset } from '../../electron/customPetProtocol'

export function AppearanceSettings({ value, customPetAsset, onCustomPetAssetChange, onChange, onClose }: {
  value: AppearancePreferences
  customPetAsset: CustomPetAsset | null
  onCustomPetAssetChange: (asset: CustomPetAsset | null) => void
  onChange: (value: AppearancePreferences) => void
  onClose: () => void
}) {
  const [status, setStatus] = useState('')
  const [uploading, setUploading] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const update = (patch: Partial<AppearancePreferences>) => { setStatus(''); onChange({ ...value, ...patch }) }
  const save = () => {
    try { onChange(saveAppearance(normalizeAppearance(value))); setStatus('设置已保存') }
    catch { setStatus('保存失败，请重试') }
  }
  const upload = async (file: File | undefined) => {
    if (!file) return
    if (!window.petcast) { setStatus('自定义图片目前仅支持 PetCast 桌面版'); return }
    if (file.size > 10 * 1024 * 1024) { setStatus('图片不能超过 10 MB'); return }
    if (file.type && !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) { setStatus('请选择 PNG、JPG 或 WebP 图片'); return }
    setUploading(true); setStatus('正在处理图片…')
    try {
      let bytes = new Uint8Array(await file.arrayBuffer())
      if (file.type === 'image/webp' || /\.webp$/i.test(file.name)) {
        const bitmap = await createImageBitmap(file)
        try {
          if (bitmap.width > 8192 || bitmap.height > 8192 || bitmap.width < 16 || bitmap.height < 16) throw new Error('invalid image dimensions')
          const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height))
          const canvas = document.createElement('canvas')
          canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale))
          const context = canvas.getContext('2d')
          if (!context) throw new Error('canvas unavailable')
          context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
          const png = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
          if (!png) throw new Error('image conversion failed')
          bytes = new Uint8Array(await png.arrayBuffer())
        } finally { bitmap.close() }
      }
      const result = await window.petcast.saveCustomPet(bytes)
      if (!result.ok || !result.asset) { setStatus(result.ok ? '图片处理失败' : result.message); return }
      onCustomPetAssetChange(result.asset)
      onChange({ ...value, petId: CUSTOM_PET_ID })
      setStatus('图片已保存在本机，点击“保存设置”完成选择')
    } catch { setStatus('图片处理失败，请重试') }
    finally { setUploading(false); if (fileInput.current) fileInput.current.value = '' }
  }
  const removeCustomPet = async () => {
    if (!window.petcast) return
    setUploading(true); setStatus('正在删除…')
    try {
      const result = await window.petcast.deleteCustomPet()
      if (!result.ok) { setStatus(result.message); return }
      onCustomPetAssetChange(null)
      const next = normalizeAppearance({ ...value, petId: 'shark' })
      onChange(next)
      saveAppearance(next)
      setStatus('自定义图片已从本机删除，已切回鲨鱼')
    } catch { setStatus('删除失败，请重试') }
    finally { setUploading(false) }
  }
  return <section className="appearance-page" aria-label="形象设置">
    <div className="room-art" /><div className="room-nameplate">{value.petName || '布罗艾'}的小屋</div>
    <section className="appearance-preview"><span>当前形象</span><div className="appearance-preview-pet"><PixelPet petId={value.petId} name={value.petName} customPetImage={customPetAsset?.dataUrl} animated /></div><strong>{value.petName || '布罗艾'}</strong></section>
    <div className="appearance-frame"><div className="appearance-paper">
      <header><h1>形象设置</h1><button onClick={onClose} aria-label="关闭形象设置">×</button></header>
      <section className="pet-choice"><h2>形象选择</h2><div className="pet-choice-row">{PETS.map(pet => <button type="button" key={pet.id} aria-label={`选择${pet.name}`} aria-pressed={value.petId === pet.id} className={value.petId === pet.id ? 'selected' : ''} onClick={() => update({ petId: pet.id })}><span><PixelPet petId={pet.id} name={value.petName} /></span><strong>{pet.name}</strong>{value.petId === pet.id && <i className="selection-check">✓</i>}</button>)}
        <button type="button" aria-label={customPetAsset ? '选择自定义宠物' : '上传自定义宠物图片'} aria-pressed={value.petId === CUSTOM_PET_ID} className={`custom-pet-choice ${value.petId === CUSTOM_PET_ID ? 'selected' : ''}`} onClick={() => customPetAsset ? update({ petId: CUSTOM_PET_ID }) : fileInput.current?.click()}><span>{customPetAsset ? <PixelPet petId={CUSTOM_PET_ID} name={value.petName} customPetImage={customPetAsset.dataUrl} /> : <i className="custom-pet-placeholder">＋</i>}</span><strong>自定义</strong>{value.petId === CUSTOM_PET_ID && <i className="selection-check">✓</i>}</button>
      </div><div className="custom-pet-tools"><input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" onChange={event => void upload(event.target.files?.[0])} /><button type="button" disabled={uploading} onClick={() => fileInput.current?.click()}>{customPetAsset ? '替换图片' : '上传图片'}</button>{customPetAsset && <button type="button" disabled={uploading} onClick={() => void removeCustomPet()}>删除</button>}<small>单张图片会自动添加呼吸、走动和庆祝效果 · 仅保存在本机</small></div></section>
      <section className="shell-choice"><h2>外观颜色</h2><div className="shell-settings-card">
        <section className="shell-settings-preview" aria-label="外壳实时预览与款式选择">
          <span>外壳实时预览</span>
          <div className="shell-preview-row"><div className="shell-live-preview"><ShellPreview shellId={value.shellId} color={value.shellColor} petId={value.petId} petName={value.petName} customPetImage={customPetAsset?.dataUrl} /></div>
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
