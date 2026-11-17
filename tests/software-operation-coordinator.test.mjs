import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const source = await readFile(new URL('../electron/softwareOperationCoordinator.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.CommonJS,
  esModuleInterop: true,
} }).outputText
const exports = {}
vm.runInNewContext(compiled, { exports, require, AbortController, setTimeout, clearTimeout, Promise })

const { SoftwareOperationCoordinator, SoftwareOperationError } = exports

const request = (operationId, steps, timeoutMs = 100) => ({
  operationId,
  target: { adapterId: 'fake-adapter', applicationId: 'fake-ai', windowHint: 'Fake AI' },
  steps,
  timeoutMs,
})

const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

test('coordinator keeps operations exclusive and rechecks the target before every step', async () => {
  const events = [], gate = deferred(), calls = []
  const coordinator = new SoftwareOperationCoordinator(event => events.push(event), {
    minTimeoutMs: 1,
    defaultTimeoutMs: 100,
    maxTimeoutMs: 1_000,
  })
  const adapter = {
    id: 'fake-adapter',
    parseStep(value) { if (typeof value !== 'string') throw Error('bad step'); return value },
    async verifyTarget(target, index) {
      calls.push(['verify-target', target.applicationId, index])
      return { windowToken: `window-${index}` }
    },
    async executeStep(step, target) {
      calls.push(['execute', step, target.windowToken])
      if (step === 'hold') await gate.promise
      return { step }
    },
    async verifyStep(step, target) {
      calls.push(['verify-step', step, target.windowToken])
      return { kind: 'step-confirmed', summary: `${step} 已核对` }
    },
  }

  const first = coordinator.run(adapter, request('operation-1', ['hold', 'finish']))
  while (!calls.some(call => call[0] === 'execute')) await Promise.resolve()
  const busy = await coordinator.run(adapter, request('operation-2', ['other']))
  assert.equal(busy.ok, false)
  assert.equal(busy.code, 'BUSY')
  gate.resolve()
  const completed = await first
  assert.equal(completed.ok, true)
  assert.equal(completed.value.completedSteps, 2)
  assert.equal(completed.value.evidence.length, 2)
  assert.equal(calls.filter(call => call[0] === 'verify-target').length, 2)
  assert.equal(calls.filter(call => call[0] === 'verify-step').length, 2)
  assert.equal(events.at(-1).stage, 'completed')
})

test('timeout and explicit stop abort the operation and request adapter cleanup', async () => {
  let stopCalls = 0
  const adapter = {
    id: 'fake-adapter',
    parseStep: value => value,
    verifyTarget: async () => ({ windowToken: 'window' }),
    executeStep: async () => await new Promise(() => undefined),
    verifyStep: async () => ({ kind: 'done', summary: 'done' }),
    stop: async () => { stopCalls += 1 },
  }
  const timed = new SoftwareOperationCoordinator(() => undefined, {
    minTimeoutMs: 1,
    defaultTimeoutMs: 5,
    maxTimeoutMs: 100,
  })
  const timedResult = await timed.run(adapter, request('timeout-operation', ['hold'], 5))
  assert.equal(timedResult.ok, false)
  assert.equal(timedResult.code, 'TIMEOUT')
  assert.equal(stopCalls, 1)

  const stopped = new SoftwareOperationCoordinator(() => undefined, {
    minTimeoutMs: 1,
    defaultTimeoutMs: 100,
    maxTimeoutMs: 1_000,
  })
  const running = stopped.run(adapter, request('stopped-operation', ['hold']))
  while (stopped.status().activeOperationId === null) await Promise.resolve()
  assert.equal(stopped.stop('stopped-operation').ok, true)
  const stoppedResult = await running
  assert.equal(stoppedResult.ok, false)
  assert.equal(stoppedResult.code, 'CANCELLED')
  assert.equal(stopCalls, 2)
})

test('manual takeover stops active work and blocks automation until explicitly released', async () => {
  const events = []
  const coordinator = new SoftwareOperationCoordinator(event => events.push(event), {
    minTimeoutMs: 1,
    defaultTimeoutMs: 100,
    maxTimeoutMs: 1_000,
  })
  const adapter = {
    id: 'fake-adapter',
    parseStep: value => value,
    verifyTarget: async () => ({ windowToken: 'window' }),
    executeStep: async step => step === 'hold' ? await new Promise(() => undefined) : { step },
    verifyStep: async () => ({ kind: 'done', summary: 'done' }),
  }
  const running = coordinator.run(adapter, request('manual-operation', ['hold']))
  while (coordinator.status().activeOperationId === null) await Promise.resolve()
  coordinator.takeManualControl()
  const interrupted = await running
  assert.equal(interrupted.ok, false)
  assert.equal(interrupted.code, 'MANUAL_CONTROL')
  assert.equal(coordinator.status().mode, 'manual')
  assert.equal((await coordinator.run(adapter, request('blocked-operation', ['quick']))).code, 'MANUAL_CONTROL')
  coordinator.releaseManualControl()
  const resumed = await coordinator.run(adapter, request('resumed-operation', ['quick']))
  assert.equal(resumed.ok, true)
  assert.equal(events.filter(event => event.stage === 'completed').length, 1)
})

test('adapter target changes fail closed and invalid actions never start an operation', async () => {
  const coordinator = new SoftwareOperationCoordinator(() => undefined, {
    minTimeoutMs: 1,
    defaultTimeoutMs: 100,
    maxTimeoutMs: 1_000,
  })
  const adapter = {
    id: 'fake-adapter',
    parseStep(value) { if (value === 'invalid') throw Error('invalid'); return value },
    verifyTarget: async () => ({ windowToken: 'window' }),
    executeStep: async step => ({ step }),
    verifyStep: async () => { throw new SoftwareOperationError('TARGET_CHANGED') },
  }
  const invalid = await coordinator.run(adapter, request('invalid-operation', ['invalid']))
  assert.equal(invalid.ok, false)
  assert.equal(invalid.code, 'INVALID_REQUEST')
  assert.equal(coordinator.status().activeOperationId, null)

  const changed = await coordinator.run(adapter, request('changed-operation', ['click']))
  assert.equal(changed.ok, false)
  assert.equal(changed.code, 'TARGET_CHANGED')
})
