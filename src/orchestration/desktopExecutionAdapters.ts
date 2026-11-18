import type { ExecutionAdapterRegistry } from './taskCoordinator'
import { MapExecutionAdapterRegistry } from './taskCoordinator'
import type { DeepSeekExecutionBridge } from './deepSeekExecutionClient'
import { createAExecutionAdapterRegistry } from './registerExecutionAdapters'
import { CodexQueueAdapter } from './CodexQueueAdapter'

/**
 * This check deliberately proves only that the trusted preload surface exists.
 * It does not read, expose, or infer the local DeepSeek API key.
 */
export const isDeepSeekExecutionBridge = (value: unknown): value is DeepSeekExecutionBridge => {
  if (!value || typeof value !== 'object') return false
  const bridge = value as Partial<DeepSeekExecutionBridge>
  return typeof bridge.dispatchDeepSeekExecution === 'function'
    && typeof bridge.inspectDeepSeekExecution === 'function'
    && typeof bridge.cancelDeepSeekExecution === 'function'
}

const browserBridge = (): unknown => (
  typeof window === 'undefined' ? undefined : window.petcast
)

/**
 * Production desktop composition. Browser builds deliberately stay empty so
 * they cannot create a provider call without Electron's constrained IPC.
 */
export const createDesktopCoordinationAdapterRegistry = (
  bridge: unknown = browserBridge(),
): ExecutionAdapterRegistry => {
  const base = isDeepSeekExecutionBridge(bridge) ? createAExecutionAdapterRegistry(bridge) : new MapExecutionAdapterRegistry()
  const desktop = bridge as typeof window.petcast | undefined
  const codex = desktop && typeof desktop.dispatchCodexQueue === 'function' && typeof desktop.inspectCodexQueue === 'function' && typeof desktop.cancelCodexQueue === 'function'
    ? new CodexQueueAdapter({ dispatch: input => desktop.dispatchCodexQueue(input), inspect: input => desktop.inspectCodexQueue(input), cancel: input => desktop.cancelCodexQueue(input) }) : undefined
  return { get: id => id === 'codex' && codex ? codex : base.get(id) }
}
