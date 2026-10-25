import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const source = await readFile(new URL('../electron/workspaceIpc.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.CommonJS,
  esModuleInterop: true,
} }).outputText

function setup({ selection = { canceled: false, filePaths: ['C:/private/project'] } } = {}) {
  const handlers = new Map()
  const listeners = new Map()
  const calls = []
  const exports = {}
  const frame = { url: 'file:///test/index.html' }
  const sender = {
    mainFrame: frame,
    once() {},
    removeListener() {},
  }
  vm.runInNewContext(compiled, {
    exports,
    URL,
    AbortController,
    DOMException,
    process,
    require(name) {
      if (name === 'electron') return {
        dialog: {
          showOpenDialog: async () => {
            calls.push('dialog')
            return selection
          },
        },
        ipcMain: {
          handle: (key, fn) => handlers.set(key, fn),
          on: (key, fn) => listeners.set(key, fn),
        },
      }
      if (name === 'node:crypto') return {
        createHmac: () => ({
          update() { return this },
          digest: () => 'a'.repeat(64),
        }),
        randomBytes: () => Buffer.alloc(32, 1),
      }
      if (name === 'node:fs') return { promises: {
        mkdir: async () => {},
        writeFile: async () => {},
        readFile: async () => Buffer.alloc(32, 1),
        realpath: async value => value,
      } }
      if (name === './workspaceProtocol.js') return {
        isWorkspaceRequestId: value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value),
      }
      if (name === './workspaceScanner.js') return {
        scanWorkspace: async (_root, options) => {
          if (options.signal.aborted) throw new DOMException('cancelled', 'AbortError')
          return { entries: [{ path: 'src/app.ts', kind: 'file', size: 12 }], truncated: false, warnings: [] }
        },
      }
      return require(name)
    },
  })
  const window = { isDestroyed: () => false, webContents: sender }
  exports.registerWorkspaceIpc(() => window, 'C:/user-data', frame.url)
  return {
    calls,
    frame,
    sender,
    invoke: (requestId, event = { sender, senderFrame: frame }) => handlers.get('workspace:select')(event, requestId),
    cancel: (requestId, event = { sender, senderFrame: frame }) => listeners.get('workspace:cancel')(event, requestId),
  }
}

test('workspace IPC accepts only the trusted main frame and hides absolute paths', async () => {
  const ipc = setup()
  const result = await ipc.invoke('workspace-1')
  assert.equal(result.ok, true)
  assert.equal(result.workspace.workspaceId, 'a'.repeat(64))
  assert.equal(result.workspace.displayName, 'project')
  assert.deepEqual(result.workspace.entries, [{ path: 'src/app.ts', kind: 'file', size: 12 }])
  assert.equal(JSON.stringify(result).includes('C:/private/project'), false)

  const untrusted = { sender: ipc.sender, senderFrame: { url: ipc.frame.url } }
  assert.equal((await ipc.invoke('workspace-2', untrusted)).code, 'INVALID_REQUEST')
  assert.equal(ipc.calls.length, 1)
})

test('workspace IPC validates request IDs and reports dialog cancellation', async () => {
  const invalid = setup()
  assert.equal((await invalid.invoke('../bad')).code, 'INVALID_REQUEST')
  assert.equal(invalid.calls.length, 0)

  const cancelled = setup({ selection: { canceled: true, filePaths: [] } })
  assert.equal((await cancelled.invoke('workspace-1')).code, 'CANCELLED')
})
