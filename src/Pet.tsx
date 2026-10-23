import { useEffect, useState } from 'react'
import type { PetMood } from './types/usage'
import { getPet } from './appearance/petRegistry'
import type { PetAnimation } from './types/appearance'
type PetProps = { dragging: boolean; expanded: boolean; dragDirection: 'left' | 'right'; mood: PetMood; reaction: 'wave' | 'eat' | null; petId?: string; name?: string }
export function Pet({ dragging, expanded, dragDirection, mood, reaction, petId = 'shark', name = '布罗艾' }: PetProps) {
  const definition = getPet(petId)
  const key: PetAnimation = dragging ? `drag-${dragDirection}` : reaction ?? (mood === 'celebrating' ? 'celebrate' : mood === 'anxious' ? 'anxious' : mood === 'tired' || mood === 'exhausted' ? 'tired' : 'idle')
  const animation = definition.animations[key] ?? definition.animations.idle!
  const [index, setIndex] = useState(0)
  useEffect(() => { setIndex(0); if (animation.frames.length < 2) return; const timer = window.setInterval(() => setIndex(i => (i + 1) % animation.frames.length), animation.frameMs); return () => clearInterval(timer) }, [definition.id, animation])
  const [column, row] = animation.frames[index % animation.frames.length]
  const x = definition.columns > 1 ? column / (definition.columns - 1) * 100 : 0
  const y = definition.rows > 1 ? row / (definition.rows - 1) * 100 : 0
  return <div className={`pet-wrap configured-pet ${dragging ? 'is-dragging' : ''} ${expanded ? 'is-expanded' : ''}`} aria-label={`${name}，${definition.name}`} data-pet-id={definition.id}>
    <div className="pet-shadow" /><span className="pet-frame" style={{ backgroundImage: `url("${definition.spriteUrl}")`, backgroundSize: definition.columns === 1 && definition.rows === 1 ? 'contain' : `${definition.columns * 100}% ${definition.rows * 100}%`, backgroundPosition: definition.columns === 1 && definition.rows === 1 ? 'center' : `${x}% ${y}%`, aspectRatio: `${definition.frameWidth} / ${definition.frameHeight}` }} /><span className="pet-hitbox" aria-hidden="true" />
  </div>
}
export function PixelPet({ petId, name = '布罗艾', className = '' }: { petId: string; name?: string; className?: string }) {
  const pet = getPet(petId)
  return <img className={`pixel-pet ${className}`} src={pet.spriteUrl} alt={`${name}，${pet.name}`} data-pet-id={pet.id} draggable={false} />
}
