import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const source = await readFile(new URL('../electron/codexEnvironmentIpc.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
} }).outputText

function setup(check) {
  const handlers = new Map(), listeners = new Map(), calls = [], exports = {}
  const frame = { url: 'file:///test/index.html' }
  const sender = { mainFrame: frame, once() {}, removeListener() {} }
  vm.runInNewContext(compiled, {
    exports, URL, AbortController,
    require(name) {
      if (name === 'electron') return { ipcMain: {
        handle: (key, fn) => handlers.set(key, fn), on: (key, fn) => listeners.set(key, fn),
      } }
      if (name === './codexEnvironment.js') return { checkCodexEnvironment: options => {
        calls.push(options)
        return check(options)
      } }
      if (name === './codexEnvironmentProtocol.js') return { MINIMUM_CODEX_VERSION: '0.163.0' }
      return require(name)
    },
  })
  exports.registerCodexEnvironmentIpc({
    getWindow: () => ({ isDestroyed: () => false, webContents: sender }),
    rendererUrl: frame.url,
    identity: { hashAccount: async () => 'codex-test' },
  })
  return {
    calls, frame, sender,
    read: (id, event = { sender, senderFrame: frame }) => handlers.get('codex:check-environment')(event, id),
    cancel: id => listeners.get('codex:cancel-environment')({ sender, senderFrame: frame }, id),
  }
}

test('environment IPC cancels an active request and permits the next one', async () => {
  const completions = []
  const ipc = setup(options => new Promise(resolve => completions.push({ resolve, signal: options.signal })))
  const first = ipc.read('first')
  await Promise.resolve()
  ipc.cancel('first')
  assert.equal(completions[0].signal.aborted, true)
  const second = ipc.read('second')
  await Promise.resolve()
  assert.equal(ipc.calls.length, 2)
  completions[0].resolve({ ok: false, code: 'CANCELLED', checkedAt: new Date().toISOString(), minimumVersion: '0.163.0' })
  await first
  completions[1].resolve({ ok: false, code: 'LOGIN_REQUIRED', checkedAt: new Date().toISOString(), minimumVersion: '0.163.0' })
  await second
})

test('environment IPC rejects untrusted frames and invalid IDs', async () => {
  const ipc = setup(async () => ({ ok: false, code: 'LOGIN_REQUIRED' }))
  assert.equal((await ipc.read('bad id')).code, 'UNAVAILABLE')
  assert.equal((await ipc.read('id', { sender: ipc.sender, senderFrame: { url: ipc.frame.url } })).code, 'UNAVAILABLE')
  ipc.frame.url = 'https://example.invalid/test/index.html'
  assert.equal((await ipc.read('id')).code, 'UNAVAILABLE')
  assert.equal(ipc.calls.length, 0)
})
