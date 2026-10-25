import { useEffect, useRef, useState } from 'react'
import { advancePetRoaming, createPetRoaming, pausePetRoaming } from './petRoaming'

export function usePetRoaming(petId: string, active: boolean) {
  const [initial] = useState(() => createPetRoaming(petId))
  const live = useRef(initial)
  const currentId = useRef(petId)
  const [state, setState] = useState(live.current)
  useEffect(() => {
    if (currentId.current !== petId) { live.current = createPetRoaming(petId); currentId.current = petId }
    else live.current = pausePetRoaming(live.current)
    setState(live.current)
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    let frame = 0, previous: number | null = null, publishedAt = 0
    const eligible = () => active && document.visibilityState !== 'hidden' && !media.matches
    const tick = (now: number) => {
      frame = 0
      if (!eligible()) { previous = null; return }
      if (previous !== null) live.current = advancePetRoaming(live.current, Math.min(100, Math.max(0, now - previous)))
      previous = now
      if (now - publishedAt >= 32) { setState(live.current); publishedAt = now }
      frame = window.requestAnimationFrame(tick)
    }
    const synchronize = () => {
      window.cancelAnimationFrame(frame); frame = 0; previous = null
      live.current = pausePetRoaming(live.current); setState(live.current)
      if (eligible()) frame = window.requestAnimationFrame(tick)
    }
    synchronize()
    document.addEventListener('visibilitychange', synchronize)
    media.addEventListener('change', synchronize)
    return () => {
      window.cancelAnimationFrame(frame)
      document.removeEventListener('visibilitychange', synchronize)
      media.removeEventListener('change', synchronize)
    }
  }, [petId, active])
  return state
}
