import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { CodexUsageProvider, type CodexUsageBridge } from './CodexUsageProvider'
import { UsageConnection, type UsageSource } from './UsageConnection'
import type { MockUsageProvider } from './MockUsageProvider'

const preferenceKey = 'petcast.usage-source.v1'
function initialSource(): UsageSource {
  try { return localStorage.getItem(preferenceKey) === 'mock' ? 'mock' : 'real' } catch { return 'real' }
}
export function useUsageConnection(mock: MockUsageProvider, bridge: CodexUsageBridge | undefined, enabled: boolean) {
  const connection = useMemo(() => new UsageConnection(
    source => source === 'real' ? new CodexUsageProvider(bridge) : mock, initialSource(),
  ), [mock, bridge])
  const state = useSyncExternalStore(connection.subscribe, connection.getSnapshot)
  useEffect(() => {
    if (enabled) connection.start()
    return () => connection.stop()
  }, [connection, enabled])
  const select = (source: UsageSource) => {
    connection.select(source)
    try { localStorage.setItem(preferenceKey, source) } catch { /* The current session still works. */ }
  }
  return { ...state, select, refresh: () => connection.refresh() }
}
