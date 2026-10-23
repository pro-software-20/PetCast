import { useId } from 'react'
import { assetUrl } from '../appearance/petRegistry'
import type { LocalDayPeriod } from '../appearance/dayCycle'

function Cloud() {
  const id = useId()
  return <svg viewBox="0 0 300 130" aria-hidden="true"><defs><linearGradient id={id} x2="0" y2="1"><stop stopColor="#fffdf5" /><stop offset="1" stopColor="#efebfb" /></linearGradient></defs><path d="M21 106C3 106 3 88 20 84C13 58 45 48 61 60C67 28 101 22 123 38C138 2 182 5 196 38C222 29 246 47 242 68C262 58 285 73 282 89C309 103 292 118 269 118L28 118C12 118 9 112 21 106Z" fill={`url(#${id})`} /></svg>
}

export function RiverBackdrop({ period }: { period: LocalDayPeriod }) {
  return <div className={`river-backdrop sky-period-${period}`} data-day-period={period} aria-hidden="true">
    <div className="river-sky" />
    <div className="river-clouds">{[0,1,2,3].map(i => <div className="river-cloud" key={i}><Cloud /></div>)}</div>
    <img className="river-art" src={assetUrl('scenes/river-foreground.png')} alt="" draggable={false} />
  </div>
}
