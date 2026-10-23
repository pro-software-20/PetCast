import { useEffect, useState } from 'react'
import { hexToHsv, hsvToHex } from '../appearance/color'
import { isShellColor, ORIGINAL_SHELL_COLOR } from '../appearance/preferences'
const SWATCHES = [{ color: ORIGINAL_SHELL_COLOR, name: '樱粉' }, { color: '#DABF8F', name: '蜂蜜黄' }, { color: '#A6BCC9', name: '雾蓝' }, { color: '#B7C4A4', name: '鼠尾草绿' }, { color: '#C1B9CE', name: '浅紫' }, { color: '#C6C5BE', name: '雾灰' }]
export function ColorPicker({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  const hsv = hexToHsv(value)
  const [hex, setHex] = useState(value)
  // Remember hue when the selected point is white, grey or black.
  const [chosenHue, setChosenHue] = useState(hsv.h)
  useEffect(() => { setHex(value); if (hsv.s > .001 && hsv.v > .001) setChosenHue(hsv.h) }, [value])
  const pick = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    onChange(hsvToHex({ h: chosenHue, s: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), v: 1 - Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) }))
  }
  return <div className="shell-color-picker" onPointerDown={e => e.stopPropagation()}>
    <div className="picker-main"><span className="picker-label">调色盘</span>
      <div className="saturation-picker" role="group" aria-label="外壳饱和度和明度调色盘" tabIndex={0}
        style={{ background: `linear-gradient(to top,#000,transparent),linear-gradient(to right,#fff,transparent),hsl(${chosenHue} 100% 50%)` }}
        onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); pick(e) }} onPointerMove={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) pick(e) }}
        onKeyDown={e => { const delta = e.shiftKey ? .1 : .01; if (e.key.startsWith('Arrow')) { e.preventDefault(); onChange(hsvToHex({ h: chosenHue, s: Math.max(0, Math.min(1, hsv.s + (e.key === 'ArrowRight' ? delta : e.key === 'ArrowLeft' ? -delta : 0))), v: Math.max(0, Math.min(1, hsv.v + (e.key === 'ArrowUp' ? delta : e.key === 'ArrowDown' ? -delta : 0))) })) } }}>
        <i style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }} />
      </div>
      <input className="hue-picker" type="range" min={0} max={359} value={Math.round(chosenHue)} aria-label="外壳色相" onChange={e => { const h = Number(e.target.value); setChosenHue(h); onChange(hsvToHex({ ...hsv, h })) }} />
    </div>
    <div className="picker-values"><label className="picker-label" htmlFor="shell-hex">当前颜色</label>
      <div className="hex-picker"><input type="color" value={value} aria-label="选择外壳颜色" onChange={e => onChange(e.target.value.toUpperCase())} /><input id="shell-hex" value={hex} maxLength={7} aria-label="外壳颜色色值" spellCheck={false} onChange={e => { setHex(e.target.value); if (isShellColor(e.target.value)) onChange(e.target.value.toUpperCase()) }} onBlur={() => setHex(value)} /></div>
      <span className="picker-label">常用颜色</span><div className="color-swatches">{SWATCHES.map(s => <button key={s.color} style={{ background: s.color }} title={s.name} aria-label={`外壳${s.name}`} aria-pressed={value === s.color} onClick={() => onChange(s.color)} />)}</div>
    </div>
  </div>
}
