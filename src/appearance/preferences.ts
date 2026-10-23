import type { AppearancePreferences } from '../types/appearance'
import { PETS, SCENES } from './petRegistry'
import { SHELLS } from './shellRegistry'
export const APPEARANCE_KEY = 'petcast.appearance.v1'
export const ORIGINAL_SHELL_COLOR = '#F8BDD3'
export const DEFAULT_APPEARANCE: AppearancePreferences = { version: 1, petId: 'shark', sceneId: 'river', petName: '布罗艾', shellId: 'cat', shellColor: ORIGINAL_SHELL_COLOR }
export const isShellColor = (value: unknown): value is string => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)
export function normalizeAppearance(value: unknown): AppearancePreferences {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ...DEFAULT_APPEARANCE }
  const saved = value as Record<string, unknown>
  if (saved.version !== 1) return { ...DEFAULT_APPEARANCE }
  const name = typeof saved.petName === 'string' ? saved.petName.replace(/[\u0000-\u001f\u007f]/g, '').trim() : ''
  return { version: 1,
    petId: PETS.some(p => p.id === saved.petId) ? String(saved.petId) : DEFAULT_APPEARANCE.petId,
    sceneId: SCENES.some(s => s.id === saved.sceneId) ? String(saved.sceneId) : DEFAULT_APPEARANCE.sceneId,
    petName: Array.from(name).slice(0, 16).join('') || DEFAULT_APPEARANCE.petName,
    shellId: SHELLS.some(s => s.id === saved.shellId) ? String(saved.shellId) : DEFAULT_APPEARANCE.shellId,
    shellColor: isShellColor(saved.shellColor) ? saved.shellColor.toUpperCase() : ORIGINAL_SHELL_COLOR,
  }
}
export function loadAppearance(): AppearancePreferences {
  try { const raw = window.localStorage.getItem(APPEARANCE_KEY); return raw ? normalizeAppearance(JSON.parse(raw)) : { ...DEFAULT_APPEARANCE } }
  catch { return { ...DEFAULT_APPEARANCE } }
}
export function saveAppearance(value: AppearancePreferences): AppearancePreferences {
  const checked = normalizeAppearance(value)
  window.localStorage.setItem(APPEARANCE_KEY, JSON.stringify(checked))
  return checked
}
