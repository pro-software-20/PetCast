import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const source = await readFile(new URL('../electron/taskExecutionIpc.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.CommonJS,
  esModuleInterop: true,
} }).outputText

function setup() {
  const handlers = new Map(), listeners = new Map(), calls = [], sent = []
  const exports = {}
  const frame = { url: 'file:///test/index.html' }
  const sender = { mainFrame: frame, send: (...args) => sent.push(args) }
  class Manager {
    constructor(_workspaces, _identity, emit) { this.emit = emit }
    prepare(input) { calls.push(['prepare', input]); this.emit({ executionId: 'execution-1', stage: 'preparing', message: 'safe' }); return { ok: true, value: {} } }
    run(id) { calls.push(['run', id]); return { ok: true, value: {} } }
    cancel(id) { calls.push(['cancel', id]); return { ok: true, value: null } }
    readArtifact(id) { calls.push(['read', id]); return { ok: true, value: {} } }
    applyArtifact(id) { calls.push(['apply', id]); return { ok: true, value: null } }
    discardArtifact(id) { calls.push(['discard', id]); return { ok: true, value: null } }
    dispose() {}
  }
  vm.runInNewContext(compiled, {
    exports,
    URL,
    require(name) {
      if (name === 'electron') return { ipcMain: { handle: (key, fn) => handlers.set(key, fn), on: (key, fn) => listeners.set(key, fn) } }
      if (name === './taskExecutionManager.js') return { TaskExecutionManager: Manager }
      if (name === './taskExecutionProtocol.js') return {
        isTaskExecutionId: value => typeof value === 'string' && /^[A-Za-z0-9-]+$/.test(value),
        TASK_EXECUTION_MESSAGES: { INVALID_REQUEST: 'invalid' },
        validatePrepareCodexTaskExecutionRequest: value => value,
      }
      return require(name)
    },
  })
  const window = { isDestroyed: () => false, webContents: sender }
  exports.registerTaskExecutionIpc({ getWindow: () => window, rendererUrl: frame.url, workspaces: {}, identity: {} })
  const event = { sender, senderFrame: frame }
  return { handlers, listeners, calls, sent, event, sender, frame }
}

test('task execution IPC accepts only the trusted main frame and exposes bounded operations', async () => {
  const ipc = setup()
  const request = { requestId: 'prepare-1' }
  assert.equal((await ipc.handlers.get('task-execution:prepare')(ipc.event, request)).ok, true)
  assert.deepEqual(ipc.calls[0], ['prepare', request])
  assert.deepEqual(ipc.sent[0], ['task-execution:event', { executionId: 'execution-1', stage: 'preparing', message: 'safe' }])

  const untrusted = { sender: ipc.sender, senderFrame: { url: ipc.frame.url } }
  assert.equal((await ipc.handlers.get('task-execution:run')(untrusted, 'execution-1')).code, 'INVALID_REQUEST')
  assert.equal(ipc.calls.some(call => call[0] === 'run'), false)
  assert.equal((await ipc.handlers.get('task-execution:artifact-read')(ipc.event, '../bad')).code, 'INVALID_REQUEST')
})
