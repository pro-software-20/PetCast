import { useEffect, useState } from 'react'
import type { PetMood } from './types/usage'
import { getPet } from './appearance/petRegistry'
import type { PetAnimation, PetAnimationClip } from './types/appearance'
import type { PetFacing } from './appearance/petRoaming'

type PetProps = {
  dragging: boolean; expanded: boolean; dragDirection: PetFacing; mood: PetMood; reaction: 'wave' | 'eat' | null;
  petId?: string; name?: string; action?: PetAnimation; facing?: PetFacing;
}

function PetImage({ petId, name, animation, animated, className }: {
  petId: string; name: string; animation: PetAnimationClip; animated: boolean; className: string;
}) {
  const pet = getPet(petId)
  const still = animation.stillUrl ?? pet.portraitUrl ?? pet.spriteUrl
  const source = animated ? animation.imageUrl ?? still : still
  const [failed, setFailed] = useState<string | null>(null)
  return <picture className="pet-picture">
    <source media="(prefers-reduced-motion: reduce)" srcSet={still} />
    <img className={className} src={failed === source ? still : source} alt={`${name}，${pet.name}`} data-pet-id={pet.id}
      data-pet-animation={animated ? 'animated' : 'still'} draggable={false} onError={() => setFailed(source)} />
  </picture>
}

export function Pet({ dragging, expanded, dragDirection, mood, reaction, petId = 'shark', name = '布罗艾', action, facing = 'right' }: PetProps) {
  const pet = getPet(petId)
  useEffect(() => {
    const images = Object.values(pet.animations).flatMap(clip => {
      if (!clip?.imageUrl) return []
      const image = new Image(); image.decoding = 'async'; image.src = clip.imageUrl
      return [image]
    })
    return () => { for (const image of images) image.onload = null }
  }, [pet])
  const requested: PetAnimation = action ?? (dragging ? `drag-${dragDirection}` : reaction ??
    (mood === 'celebrating' ? 'celebrate' : mood === 'anxious' ? 'anxious' : mood === 'tired' || mood === 'exhausted' ? 'tired' : 'idle'))
  const resolved = pet.animations[requested] ? requested : 'idle'
  const animation = pet.animations[resolved] ?? pet.animations.idle!
  return <div className={`pet-wrap configured-pet ${dragging ? 'is-dragging' : ''} ${expanded ? 'is-expanded' : ''}`}
    aria-label={`${name}，${pet.name}`} data-pet-id={pet.id} data-pet-action={resolved} data-facing={facing}>
    <div className="pet-shadow" />
    <div className="pet-facing" style={{ transform: facing === 'left' ? 'scaleX(-1)' : 'scaleX(1)' }}>
      <PetImage key={`${pet.id}-${resolved}`} petId={pet.id} name={name} animation={animation} animated className="pet-frame" />
    </div>
    <span className="pet-hitbox" aria-hidden="true" />
  </div>
}

export function PixelPet({ petId, name = '布罗艾', className = '', animated = false }: {
  petId: string; name?: string; className?: string; animated?: boolean;
}) {
  const pet = getPet(petId)
  return <PetImage key={pet.id} petId={pet.id} name={name} animation={pet.animations.idle!} animated={animated} className={`pixel-pet ${className}`} />
}
