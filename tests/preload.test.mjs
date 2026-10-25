import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

test('preload runs in a sandbox-style CommonJS environment and exposes only named methods', async () => {
  const source = await readFile(new URL('../electron/preload.ts', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
  let bridge
  const calls = []
  vm.runInNewContext(compiled, {
    exports: {},
    require(name) {
      assert.equal(name, 'electron')
      return {
        contextBridge: { exposeInMainWorld: (key, api) => { assert.equal(key, 'petcast'); bridge = api } },
        ipcRenderer: {
          invoke: (...args) => { calls.push(args); return Promise.resolve({ ok: false, code: 'LOGIN_REQUIRED' }) },
          send: (...args) => calls.push(args),
        },
      }
    },
  })
  assert.equal(bridge.invoke, undefined)
  assert.equal(bridge.readFile, undefined)
  assert.equal(bridge.exec, undefined)
  await bridge.readCodexUsage('request-1')
  bridge.cancelCodexUsage('request-1')
  await bridge.checkCodexEnvironment('environment-1')
  bridge.cancelCodexEnvironment('environment-1')
  await bridge.readChatGptSession()
  await bridge.signInWithChatGpt('auth-1')
  bridge.cancelChatGptSignIn('auth-1')
  await bridge.signOutChatGpt()
  await bridge.openChatGptUsage()
  const promptInput = { prompt: 'test', taskType: 'general', files: [] }
  await bridge.optimizeTaskPrompt(promptInput)
  await bridge.selectTaskWorkspace('workspace-1')
  bridge.cancelTaskWorkspace('workspace-1')
  const executionInput = { requestId: 'prepare-1' }
  await bridge.prepareCodexTaskExecution(executionInput)
  await bridge.runCodexTaskExecution('execution-1')
  bridge.cancelCodexTaskExecution('execution-1')
  await bridge.readTaskExecutionArtifact('artifact-1')
  await bridge.applyTaskExecutionArtifact('artifact-1')
  await bridge.discardTaskExecutionArtifact('artifact-1')
  assert.deepEqual(calls, [
    ['codex:read-usage', 'request-1'],
    ['codex:cancel-usage', 'request-1'],
    ['codex:check-environment', 'environment-1'],
    ['codex:cancel-environment', 'environment-1'],
    ['chatgpt-auth:read'],
    ['chatgpt-auth:sign-in', 'auth-1'],
    ['chatgpt-auth:cancel', 'auth-1'],
    ['chatgpt-auth:sign-out'],
    ['chatgpt-auth:open-usage'],
    ['prompt:optimize', promptInput],
    ['workspace:select', 'workspace-1'],
    ['workspace:cancel', 'workspace-1'],
    ['task-execution:prepare', executionInput],
    ['task-execution:run', 'execution-1'],
    ['task-execution:cancel', 'execution-1'],
    ['task-execution:artifact-read', 'artifact-1'],
    ['task-execution:artifact-apply', 'artifact-1'],
    ['task-execution:artifact-discard', 'artifact-1'],
  ])
  assert.equal(typeof bridge.loadGameSave, 'function')
  assert.equal(typeof bridge.beginDrag, 'function')
})
