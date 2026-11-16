import { Pet } from '../Pet'
import { getPetMovingAction } from '../appearance/petRegistry'
import { usePetRoaming } from '../appearance/usePetRoaming'

export function RoamingPet({ petId, name, active, customPetImage }: { petId: string; name: string; active: boolean; customPetImage?: string | null }) {
  const state = usePetRoaming(petId, active)
  const shark = state.habitat.kind === 'water'
  return <div className={`river-pet-anchor roaming-pet ${shark ? 'pet-in-water' : 'pet-on-sand'}`}
    style={{ left: `${state.x}%` }} data-habitat={state.habitat.kind} data-phase={active ? state.phase : 'idle'}
    data-facing={state.facing} data-active={active} data-position={state.x.toFixed(3)}>
    <Pet petId={petId} name={name} customPetImage={customPetImage} dragging={false} expanded dragDirection="right" mood="normal" reaction={null}
      action={active && state.phase === 'moving' ? getPetMovingAction(petId) : 'idle'} facing={state.facing} />
    {shark && <i className="pet-water-ripple" aria-hidden="true" />}
  </div>
}
