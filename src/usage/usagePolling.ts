import type { UsageReading, UsageReader } from './UsageReader'

/** Poll after completion, never overlap. Stop before replacing the source or unmounting. */
export function startUsagePolling(
  reader: UsageReader,
  onReading: (reading: UsageReading) => void,
  intervalMs = 30_000,
  onStart?: () => void,
) {
  if (!Number.isFinite(intervalMs) || intervalMs < 1000) throw Error('轮询间隔至少为 1000 毫秒')
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: Promise<void> | undefined
  const refresh = (): Promise<void> => {
    if (stopped) return Promise.resolve()
    if (pending) return pending
    clearTimeout(timer)
    pending = (async () => {
      onStart?.()
      const reading = await reader.read()
      if (stopped) return
      let delay = intervalMs
      if (reading.status === 'fresh') {
        // A future boundary prompts a query, never a local quota refill.
        const resets = [+reading.data.shortWindowResetAt, +reading.data.weeklyResetAt]
          .map(reset => reset - Date.now()).filter(ms => ms > 0)
        if (resets.length) delay = Math.max(1000, Math.min(intervalMs, ...resets))
      }
      try { onReading(reading) }
      finally {
        if (!stopped) timer = setTimeout(backgroundRefresh, delay)
      }
    })().finally(() => { pending = undefined })
    return pending
  }
  // Background callbacks have no caller to observe a rejection. Explicit refresh callers
  // still receive callback errors; one failed UI callback must not produce an unhandled rejection.
  const backgroundRefresh = () => { void refresh().catch(() => {}) }
  backgroundRefresh()
  return {
    refresh,
    stop() {
      if (stopped) return
      stopped = true
      clearTimeout(timer)
      reader.cancel()
    },
  }
}
