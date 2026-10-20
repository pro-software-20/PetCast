import { CodexUsageProvider, type CodexUsageBridge } from './CodexUsageProvider'
import { MockUsageProvider } from './MockUsageProvider'
import { UsageReader } from './UsageReader'

/** Explicit selection only. C must replace this session (and clear the view) on source changes. */
export function createUsageSession(source: 'real' | 'mock', bridge?: CodexUsageBridge) {
  const provider = source === 'real' ? new CodexUsageProvider(bridge) : new MockUsageProvider()
  return { provider, reader: new UsageReader(provider, 20_000) }
}
