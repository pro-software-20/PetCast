import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const source = await readFile(new URL('../electron/codexEnvironment.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
} }).outputText
const exports = {}
class CodexReadError extends Error { constructor(code) { super(code); this.code = code } }
vm.runInNewContext(compiled, {
  exports, AbortController, Buffer, setTimeout, clearTimeout,
  require(name) {
    if (name === './codexUsage.js') return {
      CodexReadError,
      resolveCodexExecutable: async () => ({ executable: 'codex.exe', source: 'path' }),
    }
    if (name === './codexEnvironmentProtocol.js') return { MINIMUM_CODEX_VERSION: '0.163.0' }
    return require(name)
  },
})

class FakeStream extends EventEmitter {
  setEncoding() {}
  end() {}
  write() { return true }
}
class FakeChild extends EventEmitter {
  stdout = new FakeStream()
  stderr = new FakeStream()
  stdin = new FakeStream()
  killed = false
  kill() { this.killed = true; return true }
}

function fakeLaunch({ version = 'codex-cli 0.163.0', account = { type: 'chatgpt', email: 'private@example.com' }, limits = { accountId: 'workspace-a' }, hangVersion = false } = {}) {
  const calls = []
  const children = []
  const rpcMethods = []
  let accountReadCount = 0
  const launch = (_executable, args) => {
    calls.push(args)
    const child = new FakeChild()
    children.push(child)
    if (args[0] === '--version') {
      if (!hangVersion) queueMicrotask(() => {
        child.stdout.emit('data', `${version}\n`)
        child.emit('close', 0)
      })
      return child
    }
    child.stdin.write = text => {
      const message = JSON.parse(text)
      if (message.id == null) return true
      rpcMethods.push(message.method)
      let result = {}
      if (message.method === 'account/read') {
        const value = Array.isArray(account) ? account[Math.min(accountReadCount, account.length - 1)] : account
        accountReadCount += 1
        result = { account: value }
      }
      if (message.method === 'account/rateLimits/read') result = limits
      queueMicrotask(() => child.stdout.emit('data', `${JSON.stringify({ id: message.id, result })}\n`))
      return true
    }
    return child
  }
  return { launch, calls, children, rpcMethods }
}

const identityCalls = []
const identity = {
  getSalt: async () => 'a'.repeat(64),
  hashAccount: async (email, accountId) => {
    identityCalls.push([email, accountId])
    return `codex-${'a'.repeat(64)}`
  },
}
const run = (fake, extra = {}) => exports.checkCodexEnvironment({
  identity,
  launch: fake.launch,
  resolveExecutable: async () => ({ executable: 'C:\\private\\codex.exe', source: 'path' }),
  now: () => new Date('2026-10-25T00:00:00.000Z'),
  ...extra,
})

test('version parsing enforces the verified minimum', () => {
  assert.equal(exports.parseCodexVersion('codex-cli 0.163.0\n'), '0.163.0')
  assert.equal(exports.parseCodexVersion('codex-cli unknown'), null)
  assert.equal(exports.isSupportedCodexVersion('0.162.9'), false)
  assert.equal(exports.isSupportedCodexVersion('0.163.0'), true)
  assert.equal(exports.isSupportedCodexVersion('1.0.0'), true)
})

test('ready check reads account scope without requiring quota window shapes', async () => {
  const fake = fakeLaunch({ limits: { accountId: 'workspace-a', rateLimits: { incomplete: true } } })
  const result = await run(fake)
  assert.equal(result.ok, true)
  assert.equal(result.cliVersion, '0.163.0')
  assert.equal(result.scopeId, `codex-${'a'.repeat(64)}`)
  assert.equal(result.authMode, 'local-codex-experimental')
  assert.deepEqual(identityCalls.at(-1), ['private@example.com', 'workspace-a'])
  assert.deepEqual(fake.calls.map(args => args[0]), ['--version', 'app-server'])
  assert.deepEqual(fake.rpcMethods, ['initialize', 'account/read', 'account/rateLimits/read', 'account/read'])
  assert.ok(!fake.rpcMethods.some(method => method === 'thread/start' || method === 'turn/start'))
  const serialized = JSON.stringify(result)
  assert.doesNotMatch(serialized, /private@example|C:\\private/)
})

test('connected ChatGPT OAuth session makes the environment ready without reading local account data', async () => {
  const fake = fakeLaunch()
  const scopeId = `codex-${'d'.repeat(64)}`
  const result = await run(fake, {
    readOAuthSession: async () => ({
      ok: true,
      status: 'connected',
      sharing: true,
      checkedAt: '2026-10-25T00:00:00.000Z',
      scopeId,
    }),
  })
  assert.equal(result.ok, true)
  assert.equal(result.scopeId, scopeId)
  assert.equal(result.authMode, 'chatgpt-oauth')
  assert.deepEqual(fake.calls.map(args => args[0]), ['--version'])
  assert.deepEqual(fake.rpcMethods, [])
})

test('OAuth is required unless the explicit local-login experiment is enabled', async () => {
  const fake = fakeLaunch()
  const readOAuthSession = async () => ({
    ok: true,
    status: 'disconnected',
    sharing: false,
    checkedAt: '2026-10-25T00:00:00.000Z',
  })
  const required = await run(fake, { readOAuthSession })
  assert.equal(required.code, 'AUTH_REQUIRED')
  assert.deepEqual(fake.calls.map(args => args[0]), ['--version'])

  const fallbackFake = fakeLaunch()
  const fallback = await run(fallbackFake, { readOAuthSession, experimentalLocalAuth: true })
  assert.equal(fallback.ok, true)
  assert.equal(fallback.authMode, 'local-codex-experimental')
})

test('old version is rejected before app-server starts', async () => {
  const fake = fakeLaunch({ version: 'codex-cli 0.162.9' })
  const result = await run(fake)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'VERSION_UNSUPPORTED')
  assert.equal(fake.calls.length, 1)
})

test('missing login and unsupported account are distinguished safely', async () => {
  const missing = await run(fakeLaunch({ account: null }))
  assert.equal(missing.code, 'LOGIN_REQUIRED')
  const api = await run(fakeLaunch({ account: { type: 'apiKey' } }))
  assert.equal(api.code, 'UNSUPPORTED_ACCOUNT')
})

test('an account switch during the probe is rejected', async () => {
  const result = await run(fakeLaunch({ account: [
    { type: 'chatgpt', email: 'first@example.com' },
    { type: 'chatgpt', email: 'second@example.com' },
  ] }))
  assert.equal(result.code, 'ACCOUNT_CHANGED')
})

test('missing executable, malformed output, timeout and cancellation return structured outcomes', async () => {
  const notFound = await exports.checkCodexEnvironment({
    identity,
    resolveExecutable: async () => { throw new CodexReadError('CLI_NOT_FOUND') },
  })
  assert.equal(notFound.code, 'CLI_NOT_FOUND')

  const malformed = await run(fakeLaunch({ version: 'not a version C:\\private\\codex.exe' }))
  assert.equal(malformed.code, 'INVALID_RESPONSE')

  const timeout = await run(fakeLaunch({ hangVersion: true }), { timeoutMs: 5 })
  assert.equal(timeout.code, 'TIMEOUT')

  const controller = new AbortController()
  const cancelled = run(fakeLaunch({ hangVersion: true }), { signal: controller.signal, timeoutMs: 1_000 })
  controller.abort()
  assert.equal((await cancelled).code, 'CANCELLED')
})
