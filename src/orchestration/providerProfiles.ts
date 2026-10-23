import type { ProviderProfile } from '../types/taskOrchestration'

export const LOCAL_PROVIDER_PROFILE: ProviderProfile = {
  id: 'local',
  displayName: '本地规则',
  capabilities: ['planning', 'text-generation'],
  executionModes: ['manual'],
  quotaSupport: 'none',
}

export const DEFAULT_PROVIDER_PROFILES: ProviderProfile[] = [
  LOCAL_PROVIDER_PROFILE,
  {
    id: 'codex',
    displayName: 'Codex',
    capabilities: ['coding', 'file-editing', 'testing'],
    executionModes: ['manual', 'local-agent'],
    quotaSupport: 'local-record',
  },
  {
    id: 'deepseek',
    displayName: 'DeepSeek',
    capabilities: ['planning', 'text-generation', 'research', 'coding'],
    executionModes: ['manual', 'api'],
    quotaSupport: 'official-api',
  },
  {
    id: 'doubao',
    displayName: '豆包',
    capabilities: ['text-generation', 'research', 'vision'],
    executionModes: ['manual', 'api'],
    quotaSupport: 'official-api',
  },
]
