import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const source = await readFile(new URL('../electron/promptOptimizationIpc.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
} }).outputText

const canonical = value => {
  if (!value || typeof value.prompt !== 'string' || !Array.isArray(value.files)) return null
  return {
    prompt: value.prompt,
    taskType: value.taskType,
    files: value.files.map(file => ({ name: file.name, type: file.type, size: file.size })),
  }
}

function setup() {
  const handlers = new Map(), exports = {}, calls = []
  const frame = { url: 'file:///test/index.html' }
  const sender = { mainFrame: frame, once() {}, removeListener() {} }
  vm.runInNewContext(compiled, {
    exports, URL, AbortController,
    require(name) {
      if (name === 'electron') return { ipcMain: { handle: (key, fn) => handlers.set(key, fn) } }
      if (name === 'node:crypto') return { randomUUID: () => '123e4567-e89b-42d3-a456-426614174000' }
      if (name === 'node:fs') return { promises: {
        mkdir: async () => {}, writeFile: async () => {},
        readFile: async () => '123e4567-e89b-42d3-a456-426614174000',
      } }
      if (name === './promptOptimizationProtocol.js') return { sanitizePromptOptimizationRequest: canonical }
      if (name === './promptOptimizationClient.js') return { requestPromptOptimization: async (input, options) => {
        calls.push({ input, options })
        return { ok: true, optimizedPrompt: 'optimized', provider: 'deepseek' }
      } }
      return require(name)
    },
  })
  exports.registerPromptOptimizationIpc(
    () => ({ isDestroyed: () => false, webContents: sender }),
    '/test', frame.url, 'https://prompt.example.test',
  )
  return {
    calls, frame, sender,
    invoke: (input, event = { sender, senderFrame: frame }) => handlers.get('prompt:optimize')(event, input),
  }
}

test('prompt IPC accepts only the main frame and forwards a sanitized DTO', async () => {
  const ipc = setup()
  const input = {
    prompt: 'test', taskType: 'general', secret: 'drop',
    files: [{ name: 'a.txt', type: 'text/plain', size: 1, content: 'drop' }],
  }
  assert.equal((await ipc.invoke(input)).ok, true)
  assert.deepEqual(ipc.calls[0].input, {
    prompt: 'test', taskType: 'general',
    files: [{ name: 'a.txt', type: 'text/plain', size: 1 }],
  })
  assert.equal(ipc.calls[0].options.installId, '123e4567-e89b-42d3-a456-426614174000')

  const untrusted = { sender: ipc.sender, senderFrame: { url: ipc.frame.url } }
  assert.equal((await ipc.invoke(input, untrusted)).code, 'INVALID_REQUEST')
  assert.equal(ipc.calls.length, 1)
})
