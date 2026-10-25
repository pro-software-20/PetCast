import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'
import { loadTs } from './load-ts.mjs'

const require = createRequire(import.meta.url)
const source = await readFile(new URL('../electron/chatGptAuth.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText

class ChatGptAuthError extends Error {
  constructor(code) { super(code); this.code = code }
}

const exports = {}
vm.runInNewContext(compiled, {
  exports,
  Buffer,
  URL,
  URLSearchParams,
  AbortController,
  Response,
  process,
  setTimeout,
  clearTimeout,
  require(name) {
    if (name === 'jose') return {
      createRemoteJWKSet: () => ({}),
      jwtVerify: async () => { throw new Error('tests inject identity verification') },
    }
    if (name === './chatGptAuthProtocol.js') return { ChatGptAuthError }
    return require(name)
  },
})

const { ChatGptAuthService } = exports
const { describeChatGptAuth } = await loadTs('../src/codex/chatGptAuth.ts')

const tokenPayload = (suffix, scope = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct', expiresIn = 3600) => ({
  access_token: `access-${suffix}`,
  refresh_token: `refresh-${suffix}`,
  id_token: `id-${suffix}`,
  token_type: 'Bearer',
  expires_in: expiresIn,
  scope,
})

function protection() {
  const values = new Map()
  let next = 0
  return {
    isAvailable: () => true,
    encrypt(value) {
      const key = `cipher-${++next}`
      values.set(key, value)
      return Buffer.from(key)
    },
    decrypt(value) {
      const plain = values.get(value.toString())
      if (!plain) throw new Error('unknown ciphertext')
      return plain
    },
  }
}

function createHarness(storageDir, options = {}) {
  let now = Date.parse('2026-10-25T00:00:00.000Z')
  let counter = 0
  const tokenRequests = []
  const authorizationUrls = []
  const callbackPages = []
  const callbackRequests = []
  let tokenRequestIndex = 0
  let callbackIndex = 0
  const fetchImpl = async (url, init = {}) => {
    if (String(url).endsWith('/.well-known/openid-configuration')) {
      return new Response(JSON.stringify({
        issuer: 'https://auth.openai.com',
        jwks_uri: 'https://auth.openai.com/.well-known/jwks.json',
        revocation_endpoint: 'https://auth.openai.com/oauth/revoke',
      }), { status: 200 })
    }
    if (String(url).endsWith('/oauth/revoke')) return new Response('', { status: 200 })
    const body = init.body instanceof URLSearchParams ? init.body : new URLSearchParams()
    tokenRequests.push(Object.fromEntries(body.entries()))
    const refresh = body.get('grant_type') === 'refresh_token'
    if (options.tokenResponse) return options.tokenResponse({
      body,
      refresh,
      index: tokenRequestIndex++,
    })
    return new Response(JSON.stringify(refresh ? tokenPayload('refresh') : tokenPayload('initial')), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  const identity = {
    hashSubject: async (subject, clientId) => `codex-${Buffer.from(`${subject}:${clientId}`).toString('hex').padEnd(64, '0').slice(0, 64)}`,
  }
  const dependencies = {
    protection: options.protection ?? protection(),
    fetchImpl,
    now: () => now,
    randomId: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`,
    verifyIdentity: async (_idToken, _clientId, nonce) => ({
      subject: 'subject-1',
      issuer: 'https://auth.openai.com',
      email: 'person@example.com',
      displayName: nonce ? 'Pet User' : 'Pet User Refreshed',
    }),
    openExternal: async url => {
      authorizationUrls.push(url)
      if (!options.realCallback) return
      callbackRequests.push((async () => {
        const authorize = new URL(url)
        const redirect = new URL(authorize.searchParams.get('redirect_uri'))
        const values = options.realCallback(authorize)
        for (const [key, value] of Object.entries(values)) redirect.searchParams.set(key, value)
        const response = await fetch(redirect)
        callbackPages.push({ status: response.status, body: await response.text() })
      })())
    },
    ...(options.realCallback ? {} : { listenForCallback: async (_state, signal) => {
      const result = options.leaveOpen
        ? new Promise((_resolve, reject) => signal.addEventListener(
            'abort',
            () => reject(new ChatGptAuthError('CANCELLED')),
            { once: true },
          ))
        : Promise.resolve(options.callbackResults?.[callbackIndex++] ?? {
            code: 'authorization-code',
            clientId: 'oaiapp_petcast_test',
          })
      return {
        redirectUri: 'http://127.0.0.1:45678/auth/callback',
        result,
        server: { close() {} },
      }
    } }),
    ...(options.signInTimeoutMs ? { signInTimeoutMs: options.signInTimeoutMs } : {}),
  }
  const service = new ChatGptAuthService(storageDir, identity, dependencies)
  return {
    service,
    tokenRequests,
    authorizationUrls,
    callbackPages,
    callbackRequests,
    advance: milliseconds => { now += milliseconds },
  }
}

test('OAuth login stores only encrypted profile data and returns a masked identity', async t => {
  const directory = await mkdtemp(path.join(process.cwd(), '.petcast-auth-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const { service } = createHarness(directory)
  const result = await service.signIn('sign-in-1')
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.status, 'connected')
  assert.equal(result.sharing, true)
  assert.equal(result.maskedEmail, 'pe****@example.com')
  const stored = await readFile(path.join(directory, 'chatgpt-auth.json'), 'utf8')
  assert.doesNotMatch(stored, /access-initial|refresh-initial|person@example\.com|subject-1/)
  assert.doesNotMatch(JSON.stringify(result), /access-|refresh-|id-initial/)
  service.dispose()
})

test('access-token refresh rotates credentials and keeps the stable anonymous scope', async t => {
  const directory = await mkdtemp(path.join(process.cwd(), '.petcast-auth-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const harness = createHarness(directory)
  const connected = await harness.service.signIn('sign-in-2')
  assert.equal(connected.ok, true, JSON.stringify(connected))
  const first = await harness.service.getAccessToken(connected.scopeId)
  assert.equal(first.accessToken, 'access-initial')
  harness.advance(3_600_000)
  const refreshed = await harness.service.getAccessToken(connected.scopeId)
  assert.equal(refreshed.accessToken, 'access-refresh')
  assert.equal(refreshed.scopeId, connected.scopeId)
  assert.equal(harness.tokenRequests.at(-1).grant_type, 'refresh_token')
  await assert.rejects(
    () => harness.service.getAccessToken(`codex-${'f'.repeat(64)}`),
    error => error.code === 'REAUTH_REQUIRED',
  )
})

test('cancel and timeout are distinct safe login outcomes', async t => {
  const firstDirectory = await mkdtemp(path.join(process.cwd(), '.petcast-auth-'))
  const secondDirectory = await mkdtemp(path.join(process.cwd(), '.petcast-auth-'))
  t.after(() => Promise.all([
    rm(firstDirectory, { recursive: true, force: true }),
    rm(secondDirectory, { recursive: true, force: true }),
  ]))

  const cancelledHarness = createHarness(firstDirectory, { leaveOpen: true })
  const cancelled = cancelledHarness.service.signIn('cancel-me')
  setTimeout(() => cancelledHarness.service.cancelSignIn('cancel-me'), 5)
  assert.equal((await cancelled).code, 'CANCELLED')

  const timeoutHarness = createHarness(secondDirectory, { leaveOpen: true, signInTimeoutMs: 5 })
  assert.equal((await timeoutHarness.service.signIn('timeout-me')).code, 'TIMEOUT')
})

test('missing direct-use scope is rejected and disconnect revokes then clears credentials', async t => {
  const directory = await mkdtemp(path.join(process.cwd(), '.petcast-auth-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const harness = createHarness(directory)
  const connected = await harness.service.signIn('sign-in-3')
  assert.equal(connected.ok, true, JSON.stringify(connected))
  const disconnected = await harness.service.disconnect()
  assert.equal(disconnected.status, 'disconnected')
  assert.equal(disconnected.remoteRevocationConfirmed, true)
  assert.equal((await harness.service.readSession()).status, 'disconnected')

  const missingDirectory = await mkdtemp(path.join(process.cwd(), '.petcast-auth-'))
  t.after(() => rm(missingDirectory, { recursive: true, force: true }))
  const missing = createHarness(missingDirectory)
  missing.service.fetchImpl = async () => new Response(JSON.stringify(tokenPayload(
    'missing',
    'openid profile email offline_access resource.invoke',
  )), { status: 200 })
  assert.equal((await missing.service.signIn('sign-in-4')).code, 'SCOPE_MISSING')
})

test('unavailable secure storage blocks sign-in safely', async t => {
  const directory = await mkdtemp(path.join(process.cwd(), '.petcast-auth-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const harness = createHarness(directory, {
    protection: {
      isAvailable: () => false,
      encrypt: value => value,
      decrypt: value => value,
    },
  })

  const result = await harness.service.signIn('storage-unavailable')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'STORAGE_UNAVAILABLE')
})

test('invalid_grant keeps the issued client and the next authorization reuses it', async t => {
  const directory = await mkdtemp(path.join(process.cwd(), '.petcast-auth-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const harness = createHarness(directory, {
    callbackResults: [
      { code: 'first-code', clientId: 'oaiapp_petcast_retry' },
      { code: 'second-code' },
    ],
    tokenResponse: ({ index }) => index === 0
      ? new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'must not leak' }), { status: 400 })
      : new Response(JSON.stringify(tokenPayload('second')), { status: 200 }),
  })

  const first = await harness.service.signIn('retry-first')
  assert.equal(first.ok, false)
  assert.equal(first.code, 'AUTHORIZATION_RETRY_REQUIRED')
  assert.doesNotMatch(JSON.stringify(first), /must not leak|first-code/)

  const second = await harness.service.signIn('retry-second')
  assert.equal(second.ok, true, JSON.stringify(second))
  assert.equal(new URL(harness.authorizationUrls[0]).searchParams.get('client_id'), 'dynamic_agent_client')
  const retryUrl = new URL(harness.authorizationUrls[1])
  assert.equal(retryUrl.searchParams.get('client_id'), 'oaiapp_petcast_retry')
  assert.equal(retryUrl.searchParams.has('agent_name_hint'), false)
})

test('nested regional and invalid-client token errors map to safe outcomes', async t => {
  const regionDirectory = await mkdtemp(path.join(process.cwd(), '.petcast-auth-'))
  const clientDirectory = await mkdtemp(path.join(process.cwd(), '.petcast-auth-'))
  t.after(() => Promise.all([
    rm(regionDirectory, { recursive: true, force: true }),
    rm(clientDirectory, { recursive: true, force: true }),
  ]))

  const region = createHarness(regionDirectory, {
    tokenResponse: () => new Response(JSON.stringify({
      error: { code: 'unsupported_country_region_territory', message: 'private upstream detail' },
    }), { status: 403 }),
  })
  const regionResult = await region.service.signIn('region-blocked')
  assert.equal(regionResult.code, 'REGION_UNSUPPORTED')
  assert.doesNotMatch(JSON.stringify(regionResult), /private upstream detail/)

  const invalidClient = createHarness(clientDirectory, {
    tokenResponse: () => new Response(JSON.stringify({ error: 'invalid_client' }), { status: 401 }),
  })
  assert.equal((await invalidClient.service.signIn('invalid-client')).code, 'INVALID_RESPONSE')
})

test('loopback callback pages distinguish received, cancelled and invalid results', async t => {
  const successDirectory = await mkdtemp(path.join(process.cwd(), '.petcast-auth-'))
  const cancelDirectory = await mkdtemp(path.join(process.cwd(), '.petcast-auth-'))
  const invalidDirectory = await mkdtemp(path.join(process.cwd(), '.petcast-auth-'))
  const errorDirectory = await mkdtemp(path.join(process.cwd(), '.petcast-auth-'))
  t.after(() => Promise.all([
    rm(successDirectory, { recursive: true, force: true }),
    rm(cancelDirectory, { recursive: true, force: true }),
    rm(invalidDirectory, { recursive: true, force: true }),
    rm(errorDirectory, { recursive: true, force: true }),
  ]))

  const success = createHarness(successDirectory, {
    realCallback: authorize => ({
      code: 'loopback-code',
      state: authorize.searchParams.get('state'),
      client_id: 'oaiapp_petcast_loopback',
    }),
  })
  assert.equal((await success.service.signIn('loopback-success')).ok, true)
  await Promise.all(success.callbackRequests)
  assert.equal(success.callbackPages[0].status, 200)
  assert.match(success.callbackPages[0].body, /授权结果已收到/)
  assert.doesNotMatch(success.callbackPages[0].body, /ChatGPT 已连接|loopback-code/)

  const cancelled = createHarness(cancelDirectory, {
    realCallback: authorize => ({
      error: 'access_denied',
      state: authorize.searchParams.get('state'),
    }),
  })
  assert.equal((await cancelled.service.signIn('loopback-cancel')).code, 'CANCELLED')
  await Promise.all(cancelled.callbackRequests)
  assert.match(cancelled.callbackPages[0].body, /授权已取消/)

  const invalid = createHarness(invalidDirectory, {
    realCallback: () => ({ code: 'invalid-state-code', state: 'wrong-state' }),
  })
  assert.equal((await invalid.service.signIn('loopback-invalid')).code, 'INVALID_RESPONSE')
  await Promise.all(invalid.callbackRequests)
  assert.equal(invalid.callbackPages[0].status, 400)
  assert.match(invalid.callbackPages[0].body, /授权结果无效/)
  assert.doesNotMatch(invalid.callbackPages[0].body, /invalid-state-code/)

  const oauthError = createHarness(errorDirectory, {
    realCallback: authorize => ({
      error: 'server_error',
      error_description: 'must not reach the renderer',
      state: authorize.searchParams.get('state'),
    }),
  })
  assert.equal((await oauthError.service.signIn('loopback-oauth-error')).code, 'INVALID_RESPONSE')
  await Promise.all(oauthError.callbackRequests)
  assert.equal(oauthError.callbackPages[0].status, 400)
  assert.match(oauthError.callbackPages[0].body, /授权结果无效/)
  assert.doesNotMatch(oauthError.callbackPages[0].body, /server_error|must not reach/)
})

test('authorization presentation offers retry and preserves manual fallback guidance', () => {
  const retry = describeChatGptAuth({
    status: 'result',
    result: { ok: false, code: 'AUTHORIZATION_RETRY_REQUIRED', checkedAt: '2026-10-25T00:00:00.000Z' },
  })
  assert.equal(retry.title, '需要重新授权 ChatGPT')
  assert.equal(retry.actionLabel, '重新授权')
  assert.match(retry.message, /复制任务 Prompt/)

  const region = describeChatGptAuth({
    status: 'result',
    result: { ok: false, code: 'REGION_UNSUPPORTED', checkedAt: '2026-10-25T00:00:00.000Z' },
  })
  assert.equal(region.title, '当前地区无法连接 ChatGPT')
  assert.match(region.message, /手动执行/)

  const connecting = describeChatGptAuth({ status: 'connecting' })
  assert.match(connecting.message, /取消后使用人工复制 Prompt/)
})
