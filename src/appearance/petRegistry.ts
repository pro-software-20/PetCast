import type { PetDefinition, SceneDefinition } from '../types/appearance'
export const assetUrl = (path: string) => `${import.meta.env?.BASE_URL ?? '/'}assets/${path}`
const pet = (id: string, name: string, width: number, height: number): PetDefinition => ({
  id, name, spriteUrl: assetUrl(`pets/${id}.png`), frameWidth: width, frameHeight: height,
  columns: 1, rows: 1, animations: { idle: { frames: [[0, 0]], frameMs: 210 } },
})
export const PETS: readonly PetDefinition[] = [pet('cat', '猫', 314, 377), pet('dog', '狗', 343, 366), pet('shark', '鲨鱼', 393, 282), pet('chicken', '鸡', 269, 333), pet('rabbit', '兔子', 293, 370)]
export const getPet = (id: string) => PETS.find(pet => pet.id === id) ?? PETS[2]
export const SCENES: readonly SceneDefinition[] = [
  { id: 'river', name: '河畔小屋', backgroundUrl: assetUrl('scenes/river-cartoon.png'), themeClass: 'warm-river' },
  { id: 'room', name: '温暖小屋', backgroundUrl: assetUrl('scenes/room-cartoon.png'), themeClass: 'warm-room' },
]
