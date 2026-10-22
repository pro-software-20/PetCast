import { ipcMain, type BrowserWindow } from 'electron'
import path from 'node:path'
import { FileTaskLedger } from './taskLedgerStore.js'
import { FileUsageHistoryStore } from './historyStore.js'
export function registerUsageHistoryIpc(getWindow: () => BrowserWindow | null, userData: string, rendererUrl: string) {
  const ledger = new FileTaskLedger(path.join(userData, 'petcast-task-ledger-v1.json'))
  const store = new FileUsageHistoryStore(path.join(userData, 'petcast-usage-history-v1.json'))
  const authorized = (event: Electron.IpcMainInvokeEvent) => {
    const window = getWindow()
    if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return false
    try {
      const actual = new URL(event.senderFrame.url), expected = new URL(rendererUrl)
      return actual.origin === expected.origin && actual.protocol === expected.protocol && actual.host === expected.host && actual.pathname === expected.pathname
    } catch { return false }
  }
  for (const [channel, action] of [
    ['tasks:execution-write', (input:unknown)=>ledger.writeExecutionEvent(input)],
    ['tasks:executions', (input:unknown)=>ledger.queryExecutions(input)],
    ['tasks:reconcile', (input:unknown)=>ledger.reconcileExecutions(input)],
    ['tasks:evaluate', (input: unknown) => ledger.appendTaskEvaluations(input)],
    ['tasks:evaluations', (input: unknown) => ledger.queryTaskEvaluations(input)],
    ['tasks:append', (input: unknown) => ledger.appendTaskRecords(input)],
    ['tasks:query', (input: unknown) => ledger.queryTaskRecords(input)],
    ['tasks:clear', (input: unknown) => ledger.clearTaskRecords(input)],
    ['history:append', (input: unknown) => store.appendUsageSample(input)],
    ['history:query', (input: unknown) => store.queryUsageSamples(input)],
    ['history:clear', (input: unknown) => store.clearUsageHistory(input)],
  ] as const) {
    ipcMain.handle(channel, async (event, input: unknown) => {
      if (!authorized(event)) return { ok: false, error: '历史访问被拒绝' }
      try { return { ok: true, data: await action(input) } }
      catch { return { ok: false, error: '历史记录读写失败。请检查数据文件或权限后重试，原文件不会被自动覆盖。' } }
    })
  }
}
