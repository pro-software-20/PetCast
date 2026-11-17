import type {
  DeepSeekExecutionDispatchInput,
  DeepSeekExecutionOutcome,
  DeepSeekExecutionReceipt,
  DeepSeekExecutionReferenceInput,
  DeepSeekExecutionSnapshot,
} from '../../electron/deepSeekExecutionProtocol'

export interface DeepSeekExecutionClient {
  dispatch(
    request: DeepSeekExecutionDispatchInput,
    signal?: AbortSignal,
  ): Promise<DeepSeekExecutionOutcome<DeepSeekExecutionReceipt>>
  inspect(
    reference: DeepSeekExecutionReferenceInput,
    signal?: AbortSignal,
  ): Promise<DeepSeekExecutionOutcome<DeepSeekExecutionSnapshot>>
  cancel(
    reference: DeepSeekExecutionReferenceInput,
    signal?: AbortSignal,
  ): Promise<DeepSeekExecutionOutcome<DeepSeekExecutionSnapshot>>
}

export interface DeepSeekExecutionBridge {
  dispatchDeepSeekExecution(
    request: DeepSeekExecutionDispatchInput,
  ): Promise<DeepSeekExecutionOutcome<DeepSeekExecutionReceipt>>
  inspectDeepSeekExecution(
    reference: DeepSeekExecutionReferenceInput,
  ): Promise<DeepSeekExecutionOutcome<DeepSeekExecutionSnapshot>>
  cancelDeepSeekExecution(
    reference: DeepSeekExecutionReferenceInput,
  ): Promise<DeepSeekExecutionOutcome<DeepSeekExecutionSnapshot>>
}

const cancelled = <T>(): DeepSeekExecutionOutcome<T> => ({
  ok: false,
  error: { code: 'CANCELLED', retryable: false, message: '执行请求已取消。' },
})
const unavailable = <T>(): DeepSeekExecutionOutcome<T> => ({
  ok: false,
  error: { code: 'UNAVAILABLE', retryable: true, message: 'DeepSeek 执行桥当前不可用。' },
})

export class BridgeDeepSeekExecutionClient implements DeepSeekExecutionClient {
  constructor(private readonly bridge?: DeepSeekExecutionBridge) {}

  async dispatch(request: DeepSeekExecutionDispatchInput, signal?: AbortSignal) {
    if (signal?.aborted) return cancelled<DeepSeekExecutionReceipt>()
    if (!this.bridge) return unavailable<DeepSeekExecutionReceipt>()
    try {
      return await this.bridge.dispatchDeepSeekExecution(structuredClone(request))
    } catch {
      return unavailable<DeepSeekExecutionReceipt>()
    }
  }

  async inspect(reference: DeepSeekExecutionReferenceInput, signal?: AbortSignal) {
    if (signal?.aborted) return cancelled<DeepSeekExecutionSnapshot>()
    if (!this.bridge) return unavailable<DeepSeekExecutionSnapshot>()
    try {
      return await this.bridge.inspectDeepSeekExecution(structuredClone(reference))
    } catch {
      return unavailable<DeepSeekExecutionSnapshot>()
    }
  }

  async cancel(reference: DeepSeekExecutionReferenceInput, signal?: AbortSignal) {
    if (signal?.aborted) return cancelled<DeepSeekExecutionSnapshot>()
    if (!this.bridge) return unavailable<DeepSeekExecutionSnapshot>()
    try {
      return await this.bridge.cancelDeepSeekExecution(structuredClone(reference))
    } catch {
      return unavailable<DeepSeekExecutionSnapshot>()
    }
  }
}

/**
 * Creates the renderer client from the Electron preload bridge.  The optional
 * parameter keeps the bridge injectable for zero-network composition tests;
 * callers never receive or inspect the local API key.
 */
export const createBrowserDeepSeekExecutionClient = (bridge?: DeepSeekExecutionBridge) => new BridgeDeepSeekExecutionClient(
  bridge ?? (typeof window === 'undefined' ? undefined : window.petcast),
)
