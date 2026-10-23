import { useState } from 'react'
import { assetUrl } from '../appearance/petRegistry'
import type { FishSpecies } from '../types/fishing'
export function FishSprite({ species }: { species: FishSpecies }) {
  const [failed, setFailed] = useState(false)
  if (failed) return null
  return <img className="fish-art" src={assetUrl(`fish/${species.id}.png`)} alt={species.name} draggable={false} onLoad={e => e.currentTarget.parentElement?.classList.add('has-fish-art')} onError={() => setFailed(true)} />
}
