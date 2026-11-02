import { TASK_BRAIN_IDS, type TaskBrainId } from '../types/taskOrchestration'

export const TASK_BRAIN_PREFERENCE_KEY = 'petcast.task-brain.v1'

export interface TaskBrainPreferenceStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

const taskBrainIds = new Set<string>(TASK_BRAIN_IDS)

const browserStorage = (): TaskBrainPreferenceStorage | undefined => {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined
  }
}

export const readTaskBrainPreference = (
  storage: TaskBrainPreferenceStorage | undefined = browserStorage(),
): TaskBrainId => {
  if (!storage) return 'local'
  try {
    const value = storage.getItem(TASK_BRAIN_PREFERENCE_KEY)
    return value && taskBrainIds.has(value) ? value as TaskBrainId : 'local'
  } catch {
    return 'local'
  }
}

export const writeTaskBrainPreference = (
  brainId: TaskBrainId,
  storage: TaskBrainPreferenceStorage | undefined = browserStorage(),
) => {
  if (!storage) return false
  try {
    storage.setItem(TASK_BRAIN_PREFERENCE_KEY, brainId)
    return true
  } catch {
    return false
  }
}
