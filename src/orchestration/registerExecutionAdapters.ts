import { DeepSeekExecutionAdapter } from './DeepSeekExecutionAdapter'
import { createBrowserDeepSeekExecutionClient } from './deepSeekExecutionClient'
import { MapExecutionAdapterRegistry } from './taskCoordinator'

/** A-owned composition helper. B decides when to inject this registry into coordination. */
export const createAExecutionAdapterRegistry = () => new MapExecutionAdapterRegistry([
  ['deepseek', new DeepSeekExecutionAdapter(createBrowserDeepSeekExecutionClient())],
])
