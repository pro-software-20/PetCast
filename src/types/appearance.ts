export type PetAnimation = 'idle' | 'drag-left' | 'drag-right' | 'wave' | 'celebrate' | 'tired' | 'anxious' | 'eat' | 'sleep' | 'walk' | 'swim' | 'hop'
export interface PetAnimationClip {
  frames: Array<readonly [number, number]>
  frameMs: number
  imageUrl?: string
  stillUrl?: string
  spriteUrl?: string
  columns?: number
  rows?: number
  frameWidth?: number
  frameHeight?: number
}
export interface PetDefinition {
  id: string
  name: string
  spriteUrl: string
  portraitUrl?: string
  frameWidth: number
  frameHeight: number
  columns: number
  rows: number
  animations: Partial<Record<PetAnimation, PetAnimationClip>>
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
  petName: string
  shellId: string
  shellColor: string
}
