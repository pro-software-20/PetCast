export type PetAnimation = 'idle' | 'drag-left' | 'drag-right' | 'wave' | 'celebrate' | 'tired' | 'anxious' | 'eat' | 'sleep'
export interface PetDefinition {
  id: string
  name: string
  spriteUrl: string
  frameWidth: number
  frameHeight: number
  columns: number
  rows: number
  animations: Partial<Record<PetAnimation, { frames: Array<readonly [number, number]>; frameMs: number }>>
  // idle is required by registry validation; missing actions fall back to idle.
}
export interface SceneDefinition {
  id: string
  name: string
  backgroundUrl: string
  themeClass: string
}
export interface AppearancePreferences {
  version: 1
  petId: string
  sceneId: string
}
