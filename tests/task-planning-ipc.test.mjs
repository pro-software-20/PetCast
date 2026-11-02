import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const source = await readFile(new URL('../electron/taskPlanningIpc.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.CommonJS,
  esModuleInterop: true,
} }).outputText

function setup() {
  const handlers = new Map(), listeners = new Map(), calls = [], senderListeners = new Map()
  const exports = {}
  const frame = { url: 'file:///test/index.html' }
  const sender = {
    mainFrame: frame,
    once: (name, listener) => senderListeners.set(name, listener),
    removeListener: (name, listener) => {
      if (senderListeners.get(name) === listener) senderListeners.delete(name)
    },
    emit: name => senderListeners.get(name)?.(),
  }
  vm.runInNewContext(compiled, {
    exports,
    URL,
    AbortController,
    process,
    require(name) {
      if (name === 'electron') return {
        ipcMain: {
          handle: (key, fn) => handlers.set(key, fn),
          on: (key, fn) => listeners.set(key, fn),
        },
      }
      if (name === 'node:crypto') return { randomUUID: () => '123e4567-e89b-42d3-a456-426614174000' }
      if (name === 'node:fs') return { promises: {
        mkdir: async () => {}, writeFile: async () => {},
        readFile: async () => '123e4567-e89b-42d3-a456-426614174000',
      } }
      if (name === './taskPlanningProtocol.js') return {
        sanitizeTaskPlanningIpcRequest: value => value?.requestId && value?.input
          ? { requestId: value.requestId, input: value.input }
          : null,
      }
      if (name === './taskPlanningClient.js') return {
        requestTaskPlan: async (input, options) => {
          calls.push(['plan', input])
          return await new Promise(resolve => {
            const finish = () => resolve({ ok: false, code: 'UPSTREAM_UNAVAILABLE' })
            if (options.signal.aborted) finish()
            else options.signal.addEventListener('abort', finish, { once: true })
          })
        },
      }
      return require(name)
    },
  })
  const window = { isDestroyed: () => false, webContents: sender }
  exports.registerTaskPlanningIpc(() => window, 'C:/data', frame.url, 'https://api.example.test')
  const event = { sender, senderFrame: frame }
  return { handlers, listeners, calls, sender, frame, event }
}

test('task planning IPC accepts only the trusted main frame and rejects duplicate request IDs', async () => {
  const ipc = setup()
  const request = { requestId: 'plan-1', input: { prompt: 'test' } }
  const pending = ipc.handlers.get('task-plan:create')(ipc.event, request)
  await Promise.resolve()
  const duplicate = await ipc.handlers.get('task-plan:create')(ipc.event, request)
  assert.equal(duplicate.code, 'RATE_LIMITED')
  const untrusted = { sender: ipc.sender, senderFrame: { url: ipc.frame.url } }
  assert.equal((await ipc.handlers.get('task-plan:create')(untrusted, request)).code, 'INVALID_REQUEST')
  ipc.listeners.get('task-plan:cancel')(ipc.event, 'plan-1')
  assert.equal((await pending).code, 'UPSTREAM_UNAVAILABLE')
})

test('task planning IPC cancels pending work when the renderer navigates', async () => {
  const ipc = setup()
  const pending = ipc.handlers.get('task-plan:create')(
    ipc.event,
    { requestId: 'plan-2', input: { prompt: 'test' } },
  )
  await Promise.resolve()
  ipc.sender.emit('did-start-navigation')
  assert.equal((await pending).code, 'UPSTREAM_UNAVAILABLE')
})
