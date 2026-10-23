import { useEffect, useState } from 'react'
import { getLocalDayCycle } from './dayCycle'

export function useLocalDayCycle() {
  const [cycle, setCycle] = useState(getLocalDayCycle)
  useEffect(() => {
    let timer: number
    const update = () => {
      window.clearTimeout(timer)
      setCycle(previous => {
        const next = getLocalDayCycle()
        return previous.period === next.period ? previous : next
      })
      // Read the local clock again each minute, including after sleep or timezone changes.
      timer = window.setTimeout(update, 60_000 - Date.now() % 60_000 + 30)
    }
    update()
    window.addEventListener('focus', update)
    document.addEventListener('visibilitychange', update)
    return () => { window.clearTimeout(timer); window.removeEventListener('focus', update); document.removeEventListener('visibilitychange', update) }
  }, [])
  return cycle
}
