import type { UsageHistoryStore, UsageSample } from '../types/usageHistory'
import { appendHistory, parseHistoryDocument, pruneHistory, sameScope, selectHistory, validateHistoryQuery, validateHistorySample, validateHistoryScope } from '../../electron/historySchema'
export const HISTORY_STORAGE_KEY = 'petcast.usage-history.v1'
export class BrowserUsageHistoryStore implements UsageHistoryStore {
  private pending: Promise<unknown> = Promise.resolve()
  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem'>, private readonly now = Date.now) {}
  private serial<T>(operation: () => T): Promise<T> {
    const run = () => typeof window !== 'undefined' && typeof navigator !== 'undefined' && navigator.locks
      ? navigator.locks.request(HISTORY_STORAGE_KEY, operation) : Promise.resolve().then(operation)
    const result = this.pending.then(run)
    this.pending = result.catch(() => undefined)
    return result
  }
  private read() {
    const text = this.storage.getItem(HISTORY_STORAGE_KEY)
    return text === null ? [] : parseHistoryDocument(text)
  }
  appendUsageSample(sample: UsageSample) {
    return this.serial(() => {
      const samples = appendHistory(this.read(), validateHistorySample(sample), this.now())
      this.storage.setItem(HISTORY_STORAGE_KEY, JSON.stringify({version: 1, samples}))
    })
  }
  queryUsageSamples(query: Parameters<UsageHistoryStore['queryUsageSamples']>[0]) {
    return this.serial(() => selectHistory(this.read(), validateHistoryQuery(query), this.now()))
  }
  clearUsageHistory(input: Parameters<UsageHistoryStore['clearUsageHistory']>[0]) {
    return this.serial(() => {
      const scope = validateHistoryScope(input)
      const samples = pruneHistory(this.read(), this.now()).filter(s => !sameScope(s, scope))
      this.storage.setItem(HISTORY_STORAGE_KEY, JSON.stringify({version: 1, samples}))
    })
  }
}
export interface HistoryBridge {
  appendUsageSample?: (sample: UsageSample) => Promise<{ok: boolean; error?: string}>
  queryUsageSamples?: (query: Parameters<UsageHistoryStore['queryUsageSamples']>[0]) => Promise<{ok: boolean; data?: unknown; error?: string}>
  clearUsageHistory?: (scope: Parameters<UsageHistoryStore['clearUsageHistory']>[0]) => Promise<{ok: boolean; error?: string}>
}
export class DesktopUsageHistoryStore implements UsageHistoryStore {
  constructor(private readonly bridge: HistoryBridge) {}
  async appendUsageSample(sample: UsageSample) {
    if (!this.bridge.appendUsageSample) throw Error('桌面历史接口不可用，请更新桌面程序')
    const result = await this.bridge.appendUsageSample(validateHistorySample(sample))
    if (!result?.ok) throw Error('历史保存失败，请检查数据文件或权限后重试')
  }
  async queryUsageSamples(query: Parameters<UsageHistoryStore['queryUsageSamples']>[0]) {
    if (!this.bridge.queryUsageSamples) throw Error('桌面历史接口不可用，请更新桌面程序')
    const result = await this.bridge.queryUsageSamples(validateHistoryQuery(query))
    if (!result?.ok || !Array.isArray(result.data)) throw Error('历史读取失败，原文件已保留，请检查文件或权限后重试')
    return result.data.map(validateHistorySample)
  }
  async clearUsageHistory(scope: Parameters<UsageHistoryStore['clearUsageHistory']>[0]) {
    if (!this.bridge.clearUsageHistory) throw Error('桌面历史接口不可用，请更新桌面程序')
    const result = await this.bridge.clearUsageHistory(validateHistoryScope(scope))
    if (!result?.ok) throw Error('历史清除失败，原文件已保留')
  }
}
export function createUsageHistoryStore(bridge: HistoryBridge | undefined): UsageHistoryStore {
  // A desktop bridge without history support is an error, never a browser-storage fallback.
  if (bridge) return new DesktopUsageHistoryStore(bridge)
  return new BrowserUsageHistoryStore({getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key,value)})
}
