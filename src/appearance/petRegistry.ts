import type { PetAnimation, PetAnimationClip, PetDefinition, SceneDefinition } from '../types/appearance'
export const assetUrl = (path: string) => `${import.meta.env?.BASE_URL ?? '/'}assets/${path}`
const IDLE_FRAMES = Array.from({ length: 16 }, (_, index) => [index % 4, Math.floor(index / 4)] as const)
const MOVING_FRAMES = Array.from({ length: 8 }, (_, index) => [index % 4, 1 + Math.floor(index / 4)] as const)
const native = (id: string, action: string) => assetUrl(`pets/rest-breathing-20261025/native/${id}-${action}.png`)
const still = (id: string, action: string) => assetUrl(`pets/rest-breathing-20261025/native/${id}-${action}-still.png`)
export const getPetMovingAction = (id: string): PetAnimation => id === 'shark' ? 'swim' : id === 'rabbit' ? 'hop' : 'walk'
const pet = (id: string, name: string, movingFrameSize: number): PetDefinition => {
  const idle: PetAnimationClip = { frames: IDLE_FRAMES, frameMs: 300, imageUrl: native(id, 'idle'), stillUrl: still(id, 'idle') }
  const moving: PetAnimationClip = { frames: MOVING_FRAMES, frameMs: id === 'rabbit' || id === 'shark' ? 220 : 190,
    imageUrl: native(id, 'move'), stillUrl: still(id, 'move'), spriteUrl: assetUrl(`pets/animations-20261025/sheets/${id}.png`),
    columns: 4, rows: 3, frameWidth: movingFrameSize, frameHeight: movingFrameSize }
  return { id, name, portraitUrl: assetUrl(`pets/${id}.png`), spriteUrl: assetUrl(`pets/rest-breathing-20261025/sheets/${id}-idle.png`),
    frameWidth: 256, frameHeight: 256, columns: 4, rows: 4, animations: { idle, [getPetMovingAction(id)]: moving } }
}
export const PETS: readonly PetDefinition[] = [pet('cat', '猫', 448), pet('dog', '狗', 448), pet('shark', '鲨鱼', 464), pet('chicken', '鸡', 448), pet('rabbit', '兔子', 336)]
export const getPet = (id: string) => PETS.find(pet => pet.id === id) ?? PETS[2]
export const SCENES: readonly SceneDefinition[] = [
  { id: 'river', name: '河畔小屋', backgroundUrl: assetUrl('scenes/river-cartoon.png'), themeClass: 'warm-river' },
  { id: 'room', name: '温暖小屋', backgroundUrl: assetUrl('scenes/room-cartoon.png'), themeClass: 'warm-room' },
]
