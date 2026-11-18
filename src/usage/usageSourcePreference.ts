export const usageSourcePreferenceKey = 'petcast.usage-source.v1'

// Desktop must not inherit hidden demo selections from older releases.
export function resolveUsageSource(desktop: boolean, saved: string | null): 'real' | 'mock' {
  return !desktop && saved === 'mock' ? 'mock' : 'real'
}
