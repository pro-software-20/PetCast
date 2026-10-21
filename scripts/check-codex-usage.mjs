import { randomBytes } from 'node:crypto'
import { readCodexQuota } from '../dist-electron/codexUsage.js'
import { CODEX_USAGE_MESSAGES } from '../dist-electron/codexProtocol.js'

// Developer diagnostics only. No account name, source response, scope ID or credential is printed.
const result = await readCodexQuota({ scopeSalt: randomBytes(32).toString('hex') })
if (!result.ok) {
  console.error(`[${result.code}] ${CODEX_USAGE_MESSAGES[result.code]}`)
  process.exitCode = 1
} else {
  const usage = result.snapshot
  console.log(JSON.stringify({
    source: 'real',
    sampledAt: usage.sampledAt,
    shortWindowRemaining: usage.shortWindowRemaining,
    weeklyRemaining: usage.weeklyRemaining,
    shortWindowResetAt: usage.shortWindowResetAt,
    weeklyResetAt: usage.weeklyResetAt,
    note: '剩余订阅额度百分比，不是 Token 账单。首次读取不计算消耗速度。',
  }, null, 2))
}
