import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { createServer, type Server, type ServerResponse } from 'node:http'
import path from 'node:path'
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose'
import type { CodexScopeIdentity } from './codexScopeIdentity.js'
import {
  ChatGptAuthError,
  type ChatGptSessionResult,
} from './chatGptAuthProtocol.js'

const AUTHORIZE_URL = 'https://auth.openai.com/api/accounts/authorize'
const TOKEN_URL = 'https://auth.openai.com/api/accounts/oauth/token'
const DISCOVERY_URL = 'https://auth.openai.com/.well-known/openid-configuration'
const RESOURCE = 'https://api.openai.com/v1'
const REQUIRED_SCOPE = 'chatgpt.tokens.use.direct'
const REQUESTED_SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'
const DYNAMIC_CLIENT_ID = 'dynamic_agent_client'

interface CredentialProtection {
  isAvailable(): boolean
  encrypt(value: string): Buffer
  decrypt(value: Buffer): string
}

interface TokenCredentials {
  accessToken: string
  refreshToken: string
  idToken: string
  tokenType: 'Bearer'
  expiresAt: number
  earliestRefreshAt?: number
  scopes: string[]
}

interface ProtectedProfile {
  clientId: string
  subject?: string
  issuer?: string
  email?: string
  displayName?: string
  credentials?: TokenCredentials
  signedOut?: boolean
  savedAt: string
}

interface StoredEnvelope {
  version: 1
  hostId: string
  encryptedProfile?: string
}

interface TokenResponse {
  access_token: string
  refresh_token: string
  id_token: string
  token_type: string
  expires_in: number
  earliest_refresh_at?: number | string
  scope: string
}

interface VerifiedIdentity {
  subject: string
  issuer: string
  email?: string
  displayName?: string
}

interface OAuthCallback {
  code: string
  clientId?: string
}

interface ClosableServer {
  close(): unknown
}

interface ChatGptAuthDependencies {
  fetchImpl?: typeof fetch
  openExternal: (url: string) => Promise<void>
  protection: CredentialProtection
  verifyIdentity?: (
    idToken: string,
    clientId: string,
    nonce: string,
    signal: AbortSignal,
  ) => Promise<VerifiedIdentity>
  now?: () => number
  randomId?: () => string
  signInTimeoutMs?: number
  listenForCallback?: (
    state: string,
    signal: AbortSignal,
  ) => Promise<{ redirectUri: string; result: Promise<OAuthCallback>; server: ClosableServer }>
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
)

const stringField = (value: unknown, max = 100_000) => (
  typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined
)

const base64Url = (value: Buffer) => value.toString('base64url')

const maskEmail = (email?: string) => {
  if (!email) return undefined
  const [local, domain] = email.split('@')
  if (!local || !domain) return undefined
  const visible = local.slice(0, Math.min(2, local.length))
  return `${visible}${'*'.repeat(Math.max(2, Math.min(6, local.length - visible.length)))}@${domain}`
}

const parseScopes = (value: string) => [...new Set(value.split(/\s+/).filter(Boolean))].sort()

const parseEarliestRefresh = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value * 1_000
  if (typeof value === 'string') {
    const numeric = Number(value)
    if (Number.isFinite(numeric) && numeric >= 0) return numeric * 1_000
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

const safeJson = async (response: Response, maxBytes = 128 * 1024) => {
  const text = await response.text()
  if (Buffer.byteLength(text) > maxBytes) throw new ChatGptAuthError('INVALID_RESPONSE')
  try { return JSON.parse(text) as unknown }
  catch { throw new ChatGptAuthError('INVALID_RESPONSE') }
}

const oauthErrorCode = (value: unknown) => {
  if (!isRecord(value)) return undefined
  const direct = stringField(value.error, 200)
  if (direct) return direct
  if (isRecord(value.error)) return stringField(value.error.code, 200)
  return stringField(value.code, 200)
}

const tokenExchangeError = (value: unknown) => {
  const code = oauthErrorCode(value)
  if (code === 'invalid_grant') return new ChatGptAuthError('AUTHORIZATION_RETRY_REQUIRED')
  if (code === 'unsupported_country_region_territory') return new ChatGptAuthError('REGION_UNSUPPORTED')
  if (code === 'invalid_client') return new ChatGptAuthError('INVALID_RESPONSE')
  return new ChatGptAuthError('UNAVAILABLE')
}

const invalidRefreshCodes = new Set([
  'invalid_grant',
  'invalid_refresh_token',
  'token_expired',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused',
])

const tokenResponse = (value: unknown, now: number): { raw: TokenResponse; credentials: TokenCredentials } => {
  if (!isRecord(value)) throw new ChatGptAuthError('INVALID_RESPONSE')
  const accessToken = stringField(value.access_token)
  const refreshToken = stringField(value.refresh_token)
  const idToken = stringField(value.id_token)
  const scope = stringField(value.scope, 4_096)
  const expiresIn = value.expires_in
  if (!accessToken || !refreshToken || !idToken || !scope || value.token_type !== 'Bearer'
    || !Number.isFinite(expiresIn) || Number(expiresIn) <= 0 || Number(expiresIn) > 86_400) {
    throw new ChatGptAuthError('INVALID_RESPONSE')
  }
  const raw = value as unknown as TokenResponse
  const earliestRefreshAt = parseEarliestRefresh(raw.earliest_refresh_at)
  return {
    raw,
    credentials: {
      accessToken,
      refreshToken,
      idToken,
      tokenType: 'Bearer',
      expiresAt: now + Number(expiresIn) * 1_000,
      ...(earliestRefreshAt == null ? {} : { earliestRefreshAt }),
      scopes: parseScopes(scope),
    },
  }
}

const mapNetworkError = (error: unknown): ChatGptAuthError => {
  if (error instanceof ChatGptAuthError) return error
  if (error instanceof Error && error.name === 'AbortError') return new ChatGptAuthError('CANCELLED')
  return new ChatGptAuthError('NETWORK_UNAVAILABLE')
}

export class ChatGptAuthService {
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly randomId: () => string
  private readonly verifyIdentityImpl: NonNullable<ChatGptAuthDependencies['verifyIdentity']>
  private readonly listenForCallbackImpl: NonNullable<ChatGptAuthDependencies['listenForCallback']>
  private activeSignIn?: { requestId: string; controller: AbortController; server?: ClosableServer }
  private refreshPromise?: Promise<{ accessToken: string; scopeId: string }>
  private operation = Promise.resolve()

  constructor(
    private readonly storageDir: string,
    private readonly identity: CodexScopeIdentity,
    private readonly dependencies: ChatGptAuthDependencies,
  ) {
    this.fetchImpl = dependencies.fetchImpl ?? fetch
    this.now = dependencies.now ?? Date.now
    this.randomId = dependencies.randomId ?? randomUUID
    this.verifyIdentityImpl = dependencies.verifyIdentity ?? this.verifyIdentity.bind(this)
    this.listenForCallbackImpl = dependencies.listenForCallback ?? this.listenForCallback.bind(this)
  }

  private get file() { return path.join(this.storageDir, 'chatgpt-auth.json') }

  private checkedAt() { return new Date(this.now()).toISOString() }

  private async withOperation<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.operation
    let release!: () => void
    this.operation = new Promise<void>(resolve => { release = resolve })
    await previous
    try { return await action() }
    finally { release() }
  }

  private async writeEnvelope(value: StoredEnvelope) {
    await fs.mkdir(this.storageDir, { recursive: true })
    const temporary = `${this.file}.${process.pid}.${this.randomId()}.tmp`
    const backup = `${this.file}.${process.pid}.${this.randomId()}.bak`
    await fs.writeFile(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 })
    let movedExisting = false
    try {
      try {
        const existing = await fs.lstat(this.file)
        if (!existing.isFile() || existing.isSymbolicLink()) throw new ChatGptAuthError('STORAGE_UNAVAILABLE')
        await fs.rename(this.file, backup)
        movedExisting = true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      await fs.rename(temporary, this.file)
      if (movedExisting) await fs.rm(backup, { force: true })
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined)
      if (movedExisting) {
        await fs.rm(this.file, { force: true }).catch(() => undefined)
        await fs.rename(backup, this.file).catch(() => undefined)
      }
      throw error
    }
  }

  private async readEnvelope(create = false): Promise<StoredEnvelope | undefined> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8')) as unknown
      if (!isRecord(parsed) || parsed.version !== 1 || typeof parsed.hostId !== 'string'
        || !/^urn:uuid:[0-9a-f-]{36}$/i.test(parsed.hostId)
        || (parsed.encryptedProfile != null && typeof parsed.encryptedProfile !== 'string')) {
        throw new ChatGptAuthError('INVALID_RESPONSE')
      }
      return parsed as unknown as StoredEnvelope
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if (!create) return undefined
      const envelope: StoredEnvelope = { version: 1, hostId: `urn:uuid:${this.randomId()}` }
      await this.writeEnvelope(envelope)
      return envelope
    }
  }

  private decryptProfile(envelope?: StoredEnvelope): ProtectedProfile | undefined {
    if (!envelope?.encryptedProfile) return undefined
    if (!this.dependencies.protection.isAvailable()) throw new ChatGptAuthError('STORAGE_UNAVAILABLE')
    let parsed: unknown
    try {
      const plain = this.dependencies.protection.decrypt(Buffer.from(envelope.encryptedProfile, 'base64'))
      parsed = JSON.parse(plain)
    } catch { throw new ChatGptAuthError('STORAGE_UNAVAILABLE') }
    if (!isRecord(parsed) || typeof parsed.clientId !== 'string' || typeof parsed.savedAt !== 'string') {
      throw new ChatGptAuthError('INVALID_RESPONSE')
    }
    return parsed as unknown as ProtectedProfile
  }

  private async saveProfile(envelope: StoredEnvelope, profile?: ProtectedProfile) {
    if (!profile) {
      const { encryptedProfile: _removed, ...withoutProfile } = envelope
      await this.writeEnvelope(withoutProfile)
      return
    }
    if (!this.dependencies.protection.isAvailable()) throw new ChatGptAuthError('STORAGE_UNAVAILABLE')
    const encryptedProfile = this.dependencies.protection.encrypt(JSON.stringify(profile)).toString('base64')
    await this.writeEnvelope({ ...envelope, encryptedProfile })
  }

  private async scopeId(profile: ProtectedProfile) {
    if (!profile.subject) throw new ChatGptAuthError('AUTH_REQUIRED')
    return this.identity.hashSubject(profile.subject, profile.clientId)
  }

  private async resultFor(profile?: ProtectedProfile): Promise<ChatGptSessionResult> {
    if (!profile || profile.signedOut) return {
      ok: true,
      status: 'disconnected',
      sharing: false,
      checkedAt: this.checkedAt(),
    }
    const safeIdentity = {
      ...(profile.displayName ? { displayName: profile.displayName } : {}),
      ...(maskEmail(profile.email) ? { maskedEmail: maskEmail(profile.email) } : {}),
    }
    if (!profile.credentials) return { ok: false, code: 'REAUTH_REQUIRED', checkedAt: this.checkedAt(), ...safeIdentity }
    if (!profile.credentials.scopes.includes(REQUIRED_SCOPE)) {
      return { ok: false, code: 'SCOPE_MISSING', checkedAt: this.checkedAt(), ...safeIdentity }
    }
    return {
      ok: true,
      status: 'connected',
      sharing: true,
      checkedAt: this.checkedAt(),
      scopeId: await this.scopeId(profile),
      ...safeIdentity,
    }
  }

  async readSession(): Promise<ChatGptSessionResult> {
    try {
      const envelope = await this.readEnvelope(false)
      return this.resultFor(this.decryptProfile(envelope))
    } catch (error) {
      const typed = error instanceof ChatGptAuthError ? error : new ChatGptAuthError('STORAGE_UNAVAILABLE')
      return { ok: false, code: typed.code, checkedAt: this.checkedAt() }
    }
  }

  private async discovery(signal: AbortSignal) {
    let response: Response
    try { response = await this.fetchImpl(DISCOVERY_URL, { signal, redirect: 'error' }) }
    catch (error) { throw mapNetworkError(error) }
    if (!response.ok) throw new ChatGptAuthError('NETWORK_UNAVAILABLE')
    const value = await safeJson(response, 32 * 1024)
    if (!isRecord(value) || value.issuer !== 'https://auth.openai.com'
      || typeof value.jwks_uri !== 'string' || !value.jwks_uri.startsWith('https://auth.openai.com/')) {
      throw new ChatGptAuthError('INVALID_RESPONSE')
    }
    return value as { issuer: string; jwks_uri: string; revocation_endpoint?: string }
  }

  private async verifyIdentity(idToken: string, clientId: string, nonce: string, signal: AbortSignal) {
    try {
      const discovery = await this.discovery(signal)
      const jwks = createRemoteJWKSet(new URL(discovery.jwks_uri), { timeoutDuration: 10_000 })
      const verified = await jwtVerify(idToken, jwks, {
        issuer: discovery.issuer,
        audience: clientId,
        clockTolerance: 30,
      })
      const payload: JWTPayload = verified.payload
      if ((nonce && payload.nonce !== nonce) || typeof payload.sub !== 'string' || !payload.sub) {
        throw new ChatGptAuthError('INVALID_RESPONSE')
      }
      if (payload.email != null && typeof payload.email !== 'string') throw new ChatGptAuthError('INVALID_RESPONSE')
      const displayName = typeof payload.name === 'string' && payload.name.trim() ? payload.name.trim().slice(0, 100) : undefined
      return {
        subject: payload.sub,
        issuer: discovery.issuer,
        ...(typeof payload.email === 'string' ? { email: payload.email.trim().toLowerCase().slice(0, 320) } : {}),
        ...(displayName ? { displayName } : {}),
      }
    } catch (error) {
      if (error instanceof ChatGptAuthError) throw error
      throw new ChatGptAuthError('INVALID_RESPONSE')
    }
  }

  private async listenForCallback(state: string, signal: AbortSignal): Promise<{
    redirectUri: string
    result: Promise<OAuthCallback>
    server: Server
  }> {
    let settle!: (value: OAuthCallback) => void
    let reject!: (error: Error) => void
    const result = new Promise<OAuthCallback>((resolve, rejectResult) => { settle = resolve; reject = rejectResult })
    let finished = false
    const finish = (action: () => void) => {
      if (finished) return
      finished = true
      signal.removeEventListener('abort', cancel)
      action()
    }
    const cancel = () => finish(() => reject(new ChatGptAuthError('CANCELLED')))
    signal.addEventListener('abort', cancel, { once: true })
    const callbackPage = (title: string, message: string) => (
      '<!doctype html><meta charset="utf-8"><title>PetCast</title>'
      + '<style>body{font:16px system-ui;padding:3rem;color:#244}main{max-width:34rem;margin:auto}</style>'
      + `<main><h1>${title}</h1><p>${message}</p></main>`
    )
    const respond = (response: ServerResponse, status: number, title: string, message: string) => {
      response.writeHead(status, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
      })
      response.end(callbackPage(title, message))
    }
    const server = createServer((request, response) => {
      let url: URL
      try { url = new URL(request.url ?? '/', 'http://127.0.0.1') }
      catch { response.writeHead(400).end('Bad request'); return }
      if (request.method !== 'GET' || url.pathname !== '/auth/callback') {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found')
        return
      }
      finish(() => {
        if (url.searchParams.get('state') !== state) {
          respond(response, 400, '授权结果无效', '请返回 PetCast 后重新尝试。')
          return reject(new ChatGptAuthError('INVALID_RESPONSE'))
        }
        const oauthError = url.searchParams.get('error')
        if (oauthError === 'access_denied') {
          respond(response, 200, '授权已取消', '可以关闭此页面并返回 PetCast。')
          return reject(new ChatGptAuthError('CANCELLED'))
        }
        if (oauthError) {
          respond(response, 400, '授权结果无效', '请返回 PetCast 后重新尝试。')
          return reject(new ChatGptAuthError('INVALID_RESPONSE'))
        }
        const code = url.searchParams.get('code')
        if (!code || code.length > 8_192) {
          respond(response, 400, '授权结果无效', '请返回 PetCast 后重新尝试。')
          return reject(new ChatGptAuthError('INVALID_RESPONSE'))
        }
        const clientId = url.searchParams.get('client_id') ?? undefined
        if (clientId && (clientId.length > 500 || !/^oaiapp_[A-Za-z0-9_-]+$/.test(clientId))) {
          respond(response, 400, '授权结果无效', '请返回 PetCast 后重新尝试。')
          return reject(new ChatGptAuthError('INVALID_RESPONSE'))
        }
        respond(response, 200, '授权结果已收到', 'PetCast 正在完成安全验证，此页面可以关闭。')
        settle({ code, ...(clientId ? { clientId } : {}) })
      })
    })
    server.on('error', () => finish(() => reject(new ChatGptAuthError('UNAVAILABLE'))))
    await new Promise<void>((resolve, rejectListen) => {
      server.listen(0, '127.0.0.1', resolve)
      server.once('error', rejectListen)
    })
    const address = server.address()
    if (!address || typeof address === 'string') {
      server.close()
      throw new ChatGptAuthError('UNAVAILABLE')
    }
    return { redirectUri: `http://127.0.0.1:${address.port}/auth/callback`, result, server }
  }

  private async exchangeCode(input: {
    clientId: string
    code: string
    verifier: string
    redirectUri: string
    signal: AbortSignal
  }) {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: input.clientId,
      code: input.code,
      code_verifier: input.verifier,
      redirect_uri: input.redirectUri,
      resource: RESOURCE,
    })
    let response: Response
    try {
      response = await this.fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: input.signal,
        redirect: 'error',
      })
    } catch (error) { throw mapNetworkError(error) }
    let value: unknown
    try { value = await safeJson(response) }
    catch (error) {
      if (!response.ok && response.status >= 500) throw new ChatGptAuthError('UNAVAILABLE')
      throw error
    }
    if (!response.ok) throw tokenExchangeError(value)
    return tokenResponse(value, this.now()).credentials
  }

  async signIn(requestId: string): Promise<ChatGptSessionResult> {
    if (this.activeSignIn) return { ok: false, code: 'UNAVAILABLE', checkedAt: this.checkedAt() }
    if (!this.dependencies.protection.isAvailable()) {
      return { ok: false, code: 'STORAGE_UNAVAILABLE', checkedAt: this.checkedAt() }
    }
    const controller = new AbortController()
    const active = { requestId, controller, server: undefined as ClosableServer | undefined }
    this.activeSignIn = active
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.dependencies.signInTimeoutMs ?? 3 * 60_000)
    try {
      return await this.withOperation(async () => {
        const envelope = await this.readEnvelope(true)
        if (!envelope) throw new ChatGptAuthError('STORAGE_UNAVAILABLE')
        let profile = this.decryptProfile(envelope)
        const state = base64Url(randomBytes(32))
        const nonce = base64Url(randomBytes(32))
        const verifier = base64Url(randomBytes(64))
        const challenge = base64Url(createHash('sha256').update(verifier).digest())
        const callback = await this.listenForCallbackImpl(state, controller.signal)
        active.server = callback.server
        const initialRegistration = !profile?.clientId
        const clientId = profile?.clientId ?? DYNAMIC_CLIENT_ID
        const authorize = new URL(AUTHORIZE_URL)
        authorize.searchParams.set('client_id', clientId)
        authorize.searchParams.set('ext_agent_host_id', envelope.hostId)
        if (initialRegistration) authorize.searchParams.set('agent_name_hint', 'PetCast')
        if (!profile?.signedOut && profile?.credentials?.idToken) authorize.searchParams.set('id_token_hint', profile.credentials.idToken)
        if (!profile?.signedOut && profile?.email) authorize.searchParams.set('login_hint', profile.email)
        authorize.searchParams.set('response_type', 'code')
        authorize.searchParams.set('redirect_uri', callback.redirectUri)
        authorize.searchParams.set('scope', REQUESTED_SCOPES)
        authorize.searchParams.set('resource', RESOURCE)
        authorize.searchParams.set('state', state)
        authorize.searchParams.set('nonce', nonce)
        authorize.searchParams.set('code_challenge_method', 'S256')
        authorize.searchParams.set('code_challenge', challenge)
        await this.dependencies.openExternal(authorize.href)
        const returned = await callback.result
        const issuedClientId = initialRegistration ? returned.clientId : profile?.clientId
        if (!issuedClientId || issuedClientId === DYNAMIC_CLIENT_ID
          || (returned.clientId && profile?.clientId && returned.clientId !== profile.clientId)) {
          throw new ChatGptAuthError('INVALID_RESPONSE')
        }
        if (!profile || profile.clientId !== issuedClientId) {
          profile = { clientId: issuedClientId, savedAt: this.checkedAt() }
          await this.saveProfile(envelope, profile)
        }
        const credentials = await this.exchangeCode({
          clientId: issuedClientId,
          code: returned.code,
          verifier,
          redirectUri: callback.redirectUri,
          signal: controller.signal,
        })
        const verified = await this.verifyIdentityImpl(credentials.idToken, issuedClientId, nonce, controller.signal)
        if (profile.subject && profile.subject !== verified.subject) throw new ChatGptAuthError('INVALID_RESPONSE')
        profile = {
          clientId: issuedClientId,
          subject: verified.subject,
          issuer: verified.issuer,
          ...(verified.email ? { email: verified.email } : {}),
          ...(verified.displayName ? { displayName: verified.displayName } : {}),
          credentials,
          signedOut: false,
          savedAt: this.checkedAt(),
        }
        await this.saveProfile(envelope, profile)
        return this.resultFor(profile)
      })
    } catch (error) {
      const typed = controller.signal.aborted
        ? new ChatGptAuthError(timedOut ? 'TIMEOUT' : 'CANCELLED')
        : error instanceof ChatGptAuthError ? error : mapNetworkError(error)
      return { ok: false, code: typed.code, checkedAt: this.checkedAt() }
    } finally {
      clearTimeout(timer)
      active.server?.close()
      if (this.activeSignIn === active) this.activeSignIn = undefined
    }
  }

  cancelSignIn(requestId: string) {
    if (this.activeSignIn?.requestId !== requestId) return
    this.activeSignIn.controller.abort()
    this.activeSignIn.server?.close()
  }

  private async refresh(profile: ProtectedProfile, envelope: StoredEnvelope) {
    const credentials = profile.credentials
    if (!credentials) throw new ChatGptAuthError('REAUTH_REQUIRED')
    const earliest = credentials.earliestRefreshAt ?? 0
    if (earliest > this.now()) throw new ChatGptAuthError('UNAVAILABLE')
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, 15_000)
    try {
      let response: Response
      try {
        response = await this.fetchImpl(TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: profile.clientId,
            refresh_token: credentials.refreshToken,
            resource: RESOURCE,
          }),
          signal: controller.signal,
          redirect: 'error',
        })
      } catch (error) { throw mapNetworkError(error) }
      const value = await safeJson(response)
      if (!response.ok) {
        const code = isRecord(value) && isRecord(value.error)
          ? stringField(value.error.code, 200)
          : isRecord(value) ? stringField(value.error, 200) : undefined
        if (code && invalidRefreshCodes.has(code)) {
          const invalid = { ...profile, credentials: undefined, signedOut: false, savedAt: this.checkedAt() }
          await this.saveProfile(envelope, invalid)
          throw new ChatGptAuthError('REAUTH_REQUIRED')
        }
        throw new ChatGptAuthError(response.status >= 500 ? 'NETWORK_UNAVAILABLE' : 'UNAVAILABLE')
      }
      const nextCredentials = tokenResponse(value, this.now()).credentials
      const verified = await this.verifyIdentityImpl(nextCredentials.idToken, profile.clientId, '', controller.signal)
      if (verified.subject !== profile.subject) throw new ChatGptAuthError('REAUTH_REQUIRED')
      const next: ProtectedProfile = {
        ...profile,
        credentials: nextCredentials,
        ...(verified.email ? { email: verified.email } : {}),
        ...(verified.displayName ? { displayName: verified.displayName } : {}),
        savedAt: this.checkedAt(),
      }
      await this.saveProfile(envelope, next)
      return next
    } catch (error) {
      if (timedOut) throw new ChatGptAuthError('TIMEOUT')
      throw error
    } finally { clearTimeout(timer) }
  }

  async getAccessToken(expectedScopeId: string): Promise<{ accessToken: string; scopeId: string }> {
    if (this.refreshPromise) return this.refreshPromise
    this.refreshPromise = this.withOperation(async () => {
      const envelope = await this.readEnvelope(false)
      if (!envelope) throw new ChatGptAuthError('AUTH_REQUIRED')
      let profile = this.decryptProfile(envelope)
      if (!profile || profile.signedOut || !profile.credentials) throw new ChatGptAuthError('AUTH_REQUIRED')
      if (!profile.credentials.scopes.includes(REQUIRED_SCOPE)) throw new ChatGptAuthError('SCOPE_MISSING')
      if (profile.credentials.expiresAt <= this.now() + 60_000) profile = await this.refresh(profile, envelope)
      const scopeId = await this.scopeId(profile)
      if (scopeId !== expectedScopeId) throw new ChatGptAuthError('REAUTH_REQUIRED')
      return { accessToken: profile.credentials!.accessToken, scopeId }
    }).finally(() => { this.refreshPromise = undefined })
    return this.refreshPromise
  }

  async disconnect(): Promise<ChatGptSessionResult> {
    this.activeSignIn?.controller.abort()
    return this.withOperation(async () => {
      try {
        const envelope = await this.readEnvelope(false)
        if (!envelope) return {
          ok: true,
          status: 'disconnected',
          sharing: false,
          checkedAt: this.checkedAt(),
          remoteRevocationConfirmed: true,
        }
        const profile = this.decryptProfile(envelope)
        if (!profile) return {
          ok: true,
          status: 'disconnected',
          sharing: false,
          checkedAt: this.checkedAt(),
          remoteRevocationConfirmed: true,
        }
        let confirmed = !profile.credentials?.refreshToken
        if (profile.credentials?.refreshToken) {
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), 15_000)
          try {
            const discovery = await this.discovery(controller.signal)
            const endpoint = discovery.revocation_endpoint
            if (typeof endpoint !== 'string' || !endpoint.startsWith('https://auth.openai.com/')) {
              throw new ChatGptAuthError('INVALID_RESPONSE')
            }
            const response = await this.fetchImpl(endpoint, {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({
                token: profile.credentials.refreshToken,
                token_type_hint: 'refresh_token',
                client_id: profile.clientId,
              }),
              signal: controller.signal,
              redirect: 'error',
            })
            confirmed = response.ok
          } catch { confirmed = false }
          finally { clearTimeout(timer) }
        }
        const signedOut: ProtectedProfile = {
          clientId: profile.clientId,
          signedOut: true,
          savedAt: this.checkedAt(),
        }
        await this.saveProfile(envelope, signedOut)
        return {
          ok: true,
          status: 'disconnected',
          sharing: false,
          checkedAt: this.checkedAt(),
          remoteRevocationConfirmed: confirmed,
        }
      } catch (error) {
        const typed = error instanceof ChatGptAuthError ? error : new ChatGptAuthError('STORAGE_UNAVAILABLE')
        return { ok: false, code: typed.code, checkedAt: this.checkedAt() }
      }
    })
  }

  dispose() {
    this.activeSignIn?.controller.abort()
    this.activeSignIn?.server?.close()
    this.activeSignIn = undefined
  }
}

