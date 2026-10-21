import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const source = await readFile(new URL('../electron/codexIpc.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
} }).outputText
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }

function setup({ readQuota, readSalt = async () => 'a'.repeat(64) } = {}) {
  const handlers = new Map(), listeners = new Map(), exports = {}, calls = []
  const frame = { url: 'file:///test/index.html' }
  const sender = { mainFrame: frame, once() {}, removeListener() {} }
  vm.runInNewContext(compiled, {
    exports, URL, AbortController,
    require(name) {
      if (name === 'electron') return { ipcMain: {
        handle: (key, fn) => handlers.set(key, fn), on: (key, fn) => listeners.set(key, fn),
      } }
      if (name === './codexUsage.js') return { readCodexQuota: options => {
        calls.push(options)
        return readQuota ? readQuota(options) : Promise.resolve({ ok: false, code: 'LOGIN_REQUIRED' })
      } }
      if (name === 'node:fs') return { promises: { mkdir: async () => {}, writeFile: async () => {}, readFile: readSalt } }
      return require(name)
    },
  })
  exports.registerCodexUsageIpc(() => ({ isDestroyed: () => false, webContents: sender }), '/test', frame.url)
  return {
    calls, frame, sender,
    read: (id, event = { sender, senderFrame: frame }) => handlers.get('codex:read-usage')(event, id),
    cancel: id => listeners.get('codex:cancel-usage')({ sender, senderFrame: frame }, id),
  }
}

test('cancelled request does not block a new session or release the new session slot on late completion', async () => {
  const completions = []
  const ipc = setup({ readQuota: () => new Promise(resolve => completions.push(resolve)) })
  const first = ipc.read('first')
  await flush()
  ipc.cancel('first')
  assert.equal(ipc.calls[0].signal.aborted, true)
  const second = ipc.read('second')
  await flush()
  assert.equal(ipc.calls.length, 2)
  completions[0]({ ok: false, code: 'CANCELLED' })
  await first
  assert.equal((await ipc.read('third')).code, 'UNAVAILABLE')
  assert.equal(ipc.calls.length, 2)
  completions[1]({ ok: false, code: 'LOGIN_REQUIRED' })
  await second
})
test('IPC rejects untrusted frame, navigated page and invalid request IDs', async () => {
  const ipc = setup()
  assert.equal((await ipc.read('bad id')).code, 'UNAVAILABLE')
  assert.equal((await ipc.read('id', { sender: ipc.sender, senderFrame: { url: ipc.frame.url } })).code, 'UNAVAILABLE')
  ipc.frame.url = 'https://example.invalid/test/index.html'
  assert.equal((await ipc.read('id')).code, 'UNAVAILABLE')
  assert.equal(ipc.calls.length, 0)
})
test('temporary salt read failure can recover on the next request', async () => {
  let count = 0
  const ipc = setup({ readSalt: async () => { if (!count++) throw Error('temporary failure'); return 'a'.repeat(64) } })
  assert.equal((await ipc.read('first')).code, 'UNAVAILABLE')
  assert.equal((await ipc.read('second')).code, 'LOGIN_REQUIRED')
  assert.equal(ipc.calls.length, 1)
})
