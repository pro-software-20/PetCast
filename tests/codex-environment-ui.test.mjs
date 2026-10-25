import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadTs } from './load-ts.mjs'

const { describeCodexEnvironment, getCodexExecutionAccess } = await loadTs('../src/codex/codexEnvironment.ts')
const base = { checkedAt: '2026-10-25T00:00:00.000Z', minimumVersion: '0.163.0' }

test('browser and failed checks preserve the manual fallback', () => {
  const browser = describeCodexEnvironment({ status: 'browser' })
  assert.match(browser.message, /复制任务 Prompt/)
  const failed = describeCodexEnvironment({ status: 'error', result: { ...base, ok: false, code: 'LOGIN_REQUIRED' } })
  assert.match(failed.message, /登录 ChatGPT/)
  assert.match(failed.message, /复制任务 Prompt/)
  assert.equal(getCodexExecutionAccess({ status: 'error', result: { ...base, ok: false, code: 'TIMEOUT' } }).available, false)
})

test('only a ready check exposes the opaque execution scope', () => {
  const ready = { status: 'ready', result: { ...base, ok: true, cliVersion: '0.163.0', scopeId: `codex-${'a'.repeat(64)}` } }
  const access = getCodexExecutionAccess(ready)
  assert.equal(access.available, true)
  assert.equal(access.scopeId, ready.result.scopeId)
  assert.match(describeCodexEnvironment(ready).title, /已就绪/)
  assert.equal(getCodexExecutionAccess({ status: 'checking' }).available, false)
})
