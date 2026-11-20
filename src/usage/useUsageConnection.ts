import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { CodexUsageProvider, type CodexUsageBridge } from './CodexUsageProvider'
import { UsageConnection, type UsageSource } from './UsageConnection'
import type { MockUsageProvider } from './MockUsageProvider'
import { resolveUsageSource, usageSourcePreferenceKey as preferenceKey } from './usageSourcePreference'

function initialSource(desktop: boolean): UsageSource {
  try { return resolveUsageSource(desktop, localStorage.getItem(preferenceKey)) } catch { return 'real' }
}
export function useUsageConnection(mock: MockUsageProvider, bridge: CodexUsageBridge | undefined, enabled: boolean) {
  const connection = useMemo(() => new UsageConnection(
    source => source === 'real' ? new CodexUsageProvider(bridge) : mock, initialSource(!!bridge),
  ), [mock, bridge])
  const state = useSyncExternalStore(connection.subscribe, connection.getSnapshot)
  useEffect(() => {
    if (bridge) {
      try { localStorage.setItem(preferenceKey, 'real') } catch { /* Real source remains enforced in memory. */ }
    }
    if (enabled) connection.start()
    const refresh = () => { if (enabled && document.visibilityState !== 'hidden') void connection.refresh().catch(() => {}) }
    window.addEventListener('focus', refresh)
    window.addEventListener('online', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.removeEventListener('focus', refresh)
      window.removeEventListener('online', refresh)
      document.removeEventListener('visibilitychange', refresh)
      connection.stop()
    }
  }, [connection, enabled, bridge])
  const select = (source: UsageSource) => {
    const selected = resolveUsageSource(!!bridge, source)
    connection.select(selected)
    try { localStorage.setItem(preferenceKey, selected) } catch { /* The current session still works. */ }
  }
  return { ...state, select, refresh: () => connection.refresh() }
}
