import { useEffect, useState } from 'react'
import type { PetMood } from './types/usage'
import { CUSTOM_PET_ID, getPet } from './appearance/petRegistry'
import type { PetAnimation, PetAnimationClip } from './types/appearance'
import { getPetFacingScale, type PetFacing } from './appearance/petRoaming'

type PetProps = {
  dragging: boolean; expanded: boolean; dragDirection: PetFacing; mood: PetMood; reaction: 'wave' | 'eat' | null;
  petId?: string; name?: string; action?: PetAnimation; facing?: PetFacing; customPetImage?: string | null;
}

function CustomPetImage({ source, name, className }: { source: string; name: string; className: string }) {
  const fallback = getPet('shark')
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [source])
  return <picture className="pet-picture">
    <img className={`${className} custom-pet-frame`} src={failed ? fallback.portraitUrl : source}
      alt={failed ? `${name}，自定义图片不可用，暂用鲨鱼` : `${name}，自定义宠物`}
      data-pet-id={failed ? fallback.id : CUSTOM_PET_ID} data-pet-animation="effect"
      draggable={false} onError={() => setFailed(true)} />
  </picture>
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

export function Pet({ dragging, expanded, dragDirection, mood, reaction, petId = 'shark', name = '布罗艾', action, facing = 'right', customPetImage }: PetProps) {
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
  if (petId === CUSTOM_PET_ID && customPetImage) {
    return <div className={`pet-wrap configured-pet ${dragging ? 'is-dragging' : ''} ${expanded ? 'is-expanded' : ''}`}
      aria-label={`${name}，自定义宠物`} data-pet-id={CUSTOM_PET_ID} data-pet-action={requested} data-facing={facing}>
      <div className="pet-shadow" />
      <div className="pet-facing" style={{ transform: `scaleX(${getPetFacingScale(CUSTOM_PET_ID, facing)})` }}>
        <CustomPetImage source={customPetImage} name={name} className="pet-frame" />
      </div>
      <span className="pet-hitbox" aria-hidden="true" />
    </div>
  }
  const resolved = pet.animations[requested] ? requested : 'idle'
  const animation = pet.animations[resolved] ?? pet.animations.idle!
  return <div className={`pet-wrap configured-pet ${dragging ? 'is-dragging' : ''} ${expanded ? 'is-expanded' : ''}`}
    aria-label={`${name}，${pet.name}`} data-pet-id={pet.id} data-pet-action={resolved} data-facing={facing}>
    <div className="pet-shadow" />
    <div className="pet-facing" style={{ transform: `scaleX(${getPetFacingScale(pet.id, facing)})` }}>
      <PetImage key={`${pet.id}-${resolved}`} petId={pet.id} name={name} animation={animation} animated className="pet-frame" />
    </div>
    <span className="pet-hitbox" aria-hidden="true" />
  </div>
}

export function PixelPet({ petId, name = '布罗艾', className = '', animated = false, customPetImage }: {
  petId: string; name?: string; className?: string; animated?: boolean; customPetImage?: string | null;
}) {
  if (petId === CUSTOM_PET_ID && customPetImage) {
    return <CustomPetImage key={customPetImage.slice(-24)} source={customPetImage} name={name}
      className={`pixel-pet ${animated ? 'custom-pet-animated' : ''} ${className}`} />
  }
  const pet = getPet(petId)
  return <PetImage key={pet.id} petId={pet.id} name={name} animation={pet.animations.idle!} animated={animated} className={`pixel-pet ${className}`} />
}
