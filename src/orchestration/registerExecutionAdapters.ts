import { DeepSeekExecutionAdapter } from './DeepSeekExecutionAdapter'
import {
  createBrowserDeepSeekExecutionClient,
  type DeepSeekExecutionBridge,
} from './deepSeekExecutionClient'
import { MapExecutionAdapterRegistry } from './taskCoordinator'

/** A-owned composition helper. B decides when to inject this registry into coordination. */
export const createAExecutionAdapterRegistry = (bridge?: DeepSeekExecutionBridge) => new MapExecutionAdapterRegistry([
  ['deepseek', new DeepSeekExecutionAdapter(createBrowserDeepSeekExecutionClient(bridge))],
])
