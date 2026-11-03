import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const temporary = await mkdtemp(path.join(os.tmpdir(), 'petcast-server-package-'))
const statePath = path.join(temporary, 'rate-limits.json')

const reservePort = () => new Promise((resolve, reject) => {
  const server = createServer()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    server.close(error => error ? reject(error) : resolve(address.port))
  })
})

const port = await reservePort()
const child = spawn(process.execPath, ['dist-server/server/main.js'], {
  cwd: root,
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    DEEPSEEK_API_KEY: 'package-test-key',
    RATE_LIMIT_HASH_SECRET: 'package-test-secret-with-at-least-32-characters',
    PROMPT_RATE_LIMIT_STATE_PATH: statePath,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

const waitForHealth = async () => {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`)
      if (response.ok) return response.json()
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Packaged AI service did not become healthy.')
}

try {
  assert.deepEqual(await waitForHealth(), { ok: true, service: 'petcast-ai', version: 1 })
  const invalid = await fetch(`http://127.0.0.1:${port}/v1/task/plan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  assert.equal(invalid.status, 400)
} finally {
  child.kill('SIGTERM')
  await new Promise(resolve => {
    child.once('exit', resolve)
    setTimeout(() => {
      if (child.exitCode === null) child.kill()
      resolve()
    }, 5_000).unref()
  })
}

const dockerfile = await readFile(path.join(root, 'Dockerfile'), 'utf8')
const dockerignore = await readFile(path.join(root, '.dockerignore'), 'utf8')
const renderBlueprint = await readFile(path.join(root, 'render.yaml'), 'utf8')
assert.match(dockerfile, /FROM node:22-bookworm-slim AS runtime/)
assert.match(dockerfile, /USER node/)
assert.match(dockerfile, /PROMPT_RATE_LIMIT_STATE_PATH=\/data\/rate-limits\.json/)
assert.match(dockerfile, /HEALTHCHECK/)
assert.doesNotMatch(dockerfile, /COPY\s+\.\s+\./)
assert.match(dockerignore, /^\.env\.\*$/m)
assert.match(dockerignore, /^work$/m)
assert.match(renderBlueprint, /runtime:\s+docker/)
assert.match(renderBlueprint, /region:\s+singapore/)
assert.match(renderBlueprint, /plan:\s+0\.5c-512mb/)
assert.match(renderBlueprint, /numInstances:\s+1/)
assert.match(renderBlueprint, /healthCheckPath:\s+\/health/)
assert.match(renderBlueprint, /mountPath:\s+\/data/)
assert.match(renderBlueprint, /key:\s+DEEPSEEK_API_KEY\s+sync:\s+false/s)
assert.match(renderBlueprint, /key:\s+RATE_LIMIT_HASH_SECRET\s+generateValue:\s+true/s)
assert.doesNotMatch(renderBlueprint, /(?:sk-|oaiapp_|Bearer\s+)[A-Za-z0-9_-]{8,}/)

const runtimeFiles = await readdir(path.join(root, 'dist-server'), { recursive: true })
assert(runtimeFiles.length > 0)
assert(runtimeFiles.every(file => !/\.env(?:\.|$)|\.ts$/i.test(String(file))))

const { AnonymousRateLimiter } = await import('../dist-server/server/anonymousRateLimiter.js')
const limits = {
  installPerMinute: 10,
  installPerDay: 1,
  ipPerMinute: 10,
  ipPerDay: 10,
  globalPerDay: 10,
}
const firstLimiter = new AnonymousRateLimiter(
  'persistent-rate-limit-secret-with-32-characters', statePath, limits,
)
assert.deepEqual(await firstLimiter.consume('install-a', '127.0.0.1'), { allowed: true })
const restoredLimiter = new AnonymousRateLimiter(
  'persistent-rate-limit-secret-with-32-characters', statePath, limits,
)
assert.equal((await restoredLimiter.consume('install-a', '127.0.0.1')).allowed, false)

console.log('PetCast AI server package checks passed.')
