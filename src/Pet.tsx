import { useEffect, useState } from 'react'
import type { PetMood } from './types/usage'

type PetProps = {
  dragging: boolean
  expanded: boolean
  dragDirection: 'left' | 'right'
  mood: PetMood
  reaction: 'wave' | 'eat' | null
}
type Frame = readonly [column: number, row: number]

// The supplied sheet is 1536 × 1872: 8 columns × 9 rows,
// so every source frame is exactly 192 × 208 pixels.
const IDLE_FRAMES: readonly Frame[] = [
  [0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0], [4, 0], [3, 0], [2, 0], [1, 0],
]
const DRAG_RIGHT_FRAMES: readonly Frame[] = [
  [0, 1], [1, 1], [2, 1], [3, 1], [4, 1], [5, 1], [6, 1], [7, 1],
]
const DRAG_LEFT_FRAMES: readonly Frame[] = [
  [0, 2], [1, 2], [2, 2], [3, 2], [4, 2], [5, 2], [6, 2], [7, 2],
]
const WAVE_FRAMES: readonly Frame[] = [[0, 3], [1, 3], [2, 3], [3, 3]]
const CELEBRATE_FRAMES: readonly Frame[] = [[0, 4], [1, 4], [2, 4], [3, 4], [4, 4]]
const TIRED_FRAMES: readonly Frame[] = [[0, 5], [1, 5], [2, 5], [3, 5], [4, 5], [5, 5], [6, 5], [7, 5]]
const ANXIOUS_FRAMES: readonly Frame[] = [[0, 6], [1, 6], [2, 6], [3, 6], [4, 6], [5, 6]]
const EAT_FRAMES: readonly Frame[] = [[0, 7], [1, 7], [2, 7], [3, 7], [4, 7], [5, 7], [6, 7], [7, 7]]

export function Pet({ dragging, expanded, dragDirection, mood, reaction }: PetProps) {
  const [frameIndex, setFrameIndex] = useState(0)
  const animationKey = dragging
    ? `drag-${dragDirection}`
    : reaction === 'eat'
      ? 'eat'
      : reaction === 'wave'
      ? 'wave'
      : mood === 'celebrating'
        ? 'celebrate'
        : mood === 'anxious'
          ? 'anxious'
          : mood === 'tired' || mood === 'exhausted'
            ? 'tired'
            : 'idle'
  const frames = animationKey === 'drag-left' ? DRAG_LEFT_FRAMES
    : animationKey === 'drag-right' ? DRAG_RIGHT_FRAMES
      : animationKey === 'eat' ? EAT_FRAMES
        : animationKey === 'wave' ? WAVE_FRAMES
        : animationKey === 'celebrate' ? CELEBRATE_FRAMES
          : animationKey === 'anxious' ? ANXIOUS_FRAMES
            : animationKey === 'tired' ? TIRED_FRAMES
              : IDLE_FRAMES

  useEffect(() => {
    setFrameIndex(0)
    const timer = window.setInterval(
      () => setFrameIndex((current) => (current + 1) % frames.length),
      dragging ? 95 : animationKey === 'eat' ? 135 : animationKey === 'tired' ? 230 : expanded ? 170 : 210,
    )
    return () => window.clearInterval(timer)
  }, [animationKey, dragging, expanded, frames.length])

  const [column, row] = frames[frameIndex % frames.length]
  const backgroundPosition = `${(column / 7) * 100}% ${(row / 8) * 100}%`

  return (
    <div
      className={`pet-wrap ${dragging ? 'is-dragging' : ''}`}
      aria-label="布罗艾蓝色毛绒鲨鱼"
    >
      <div className="pet-shadow" />
      <span className="pet-frame" style={{ backgroundPosition }} />
      <span className="pet-hitbox" aria-hidden="true" />
    </div>
  )
}
