import type { TaskBrainId, TaskBrainProfile } from '../types/taskOrchestration'

export const LOCAL_TASK_BRAIN_PROFILE: TaskBrainProfile = {
  id: 'local',
  displayName: '本地规则',
  mode: 'local',
}

export const DEEPSEEK_TASK_BRAIN_PROFILE: TaskBrainProfile = {
  id: 'deepseek',
  displayName: 'DeepSeek',
  mode: 'remote',
}

export const TASK_BRAIN_PROFILES: Record<TaskBrainId, TaskBrainProfile> = {
  local: LOCAL_TASK_BRAIN_PROFILE,
  deepseek: DEEPSEEK_TASK_BRAIN_PROFILE,
}
