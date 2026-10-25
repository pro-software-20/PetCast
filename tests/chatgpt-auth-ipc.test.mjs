import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const source = await readFile(new URL('../electron/chatGptAuthIpc.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText

function setup() {
  const handlers = new Map(), listeners = new Map(), calls = [], opened = []
  const exports = {}
  const frame = { url: 'file:///test/index.html' }
  const sender = { mainFrame: frame }
  const auth = {
    readSession: async () => { calls.push(['read']); return { ok: true, status: 'disconnected', sharing: false } },
    signIn: async id => { calls.push(['sign-in', id]); return { ok: true, status: 'connected', sharing: true } },
    cancelSignIn: id => calls.push(['cancel', id]),
    disconnect: async () => { calls.push(['sign-out']); return { ok: true, status: 'disconnected', sharing: false } },
  }
  vm.runInNewContext(compiled, {
    exports,
    URL,
    require(name) {
      if (name === 'electron') return {
        ipcMain: {
          handle: (key, fn) => handlers.set(key, fn),
          on: (key, fn) => listeners.set(key, fn),
        },
        shell: { openExternal: async url => { opened.push(url) } },
      }
      if (name === './chatGptAuthProtocol.js') return {
        isChatGptAuthRequestId: value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,160}$/.test(value),
      }
      return require(name)
    },
  })
  exports.registerChatGptAuthIpc({
    getWindow: () => ({ isDestroyed: () => false, webContents: sender }),
    rendererUrl: frame.url,
    auth,
  })
  const event = { sender, senderFrame: frame }
  return { handlers, listeners, calls, opened, event, sender, frame }
}

test('ChatGPT auth IPC exposes only bounded account operations to the trusted main frame', async () => {
  const ipc = setup()
  assert.equal((await ipc.handlers.get('chatgpt-auth:read')(ipc.event)).status, 'disconnected')
  assert.equal((await ipc.handlers.get('chatgpt-auth:sign-in')(ipc.event, 'login-1')).status, 'connected')
  ipc.listeners.get('chatgpt-auth:cancel')(ipc.event, 'login-1')
  assert.equal((await ipc.handlers.get('chatgpt-auth:sign-out')(ipc.event)).status, 'disconnected')
  assert.equal(await ipc.handlers.get('chatgpt-auth:open-usage')(ipc.event), true)
  assert.deepEqual(ipc.calls, [['read'], ['sign-in', 'login-1'], ['cancel', 'login-1'], ['sign-out']])
  assert.deepEqual(ipc.opened, ['https://chatgpt.com/settings/usage'])
})

test('ChatGPT auth IPC rejects untrusted frames and malformed request IDs', async () => {
  const ipc = setup()
  const untrusted = { sender: ipc.sender, senderFrame: { url: ipc.frame.url } }
  assert.equal((await ipc.handlers.get('chatgpt-auth:read')(untrusted)).code, 'UNAVAILABLE')
  assert.equal((await ipc.handlers.get('chatgpt-auth:sign-in')(ipc.event, 'bad id')).code, 'UNAVAILABLE')
  ipc.listeners.get('chatgpt-auth:cancel')(ipc.event, 'bad id')
  assert.equal(await ipc.handlers.get('chatgpt-auth:open-usage')(untrusted), false)
  assert.deepEqual(ipc.calls, [])
  assert.deepEqual(ipc.opened, [])
})
