import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTs } from './load-ts.mjs'
import { createPublicAiServiceConfig, normalizePublicAiServiceUrl } from '../scripts/public-ai-config.mjs'

const { normalizeAiServiceUrl, resolveAiServiceUrl } = await loadTs('../electron/aiServiceConfig.ts')

test('development runtime endpoint accepts HTTPS and loopback HTTP only', () => {
  assert.equal(normalizeAiServiceUrl('https://ai.example.com/path', true), 'https://ai.example.com')
  assert.equal(normalizeAiServiceUrl('http://127.0.0.1:8787', true), 'http://127.0.0.1:8787')
  assert.equal(normalizeAiServiceUrl('http://example.com', true), null)
  assert.equal(normalizeAiServiceUrl('https://user:pass@example.com', true), null)
})

test('development runtime endpoint overrides packaged configuration', async () => {
  let read = false
  const value = await resolveAiServiceUrl({
    configPath: 'unused.json',
    runtimeUrl: 'http://localhost:8787',
    allowRuntimeOverride: true,
    readFileImpl: async () => { read = true; return Buffer.from('{}') },
  })
  assert.equal(value, 'http://localhost:8787')
  assert.equal(read, false)
})

test('packaged configuration accepts only a bounded HTTPS origin', async () => {
  const read = value => async () => Buffer.from(JSON.stringify(value))
  assert.equal(await resolveAiServiceUrl({
    configPath: 'config.json', allowRuntimeOverride: false,
    readFileImpl: read({ version: 1, aiApiUrl: 'https://ai.example.com/service' }),
  }), 'https://ai.example.com')
  assert.equal(await resolveAiServiceUrl({
    configPath: 'config.json', allowRuntimeOverride: false,
    readFileImpl: read({ version: 1, aiApiUrl: 'http://127.0.0.1:8787' }),
  }), '')
  assert.equal(await resolveAiServiceUrl({
    configPath: 'config.json', allowRuntimeOverride: false,
    readFileImpl: async () => { throw new Error('missing') },
  }), '')
})

test('public installer configuration rejects missing or unsafe URLs', () => {
  assert.equal(normalizePublicAiServiceUrl('https://ai.example.com/path'), 'https://ai.example.com')
  assert.deepEqual(createPublicAiServiceConfig('https://ai.example.com'), {
    version: 1, aiApiUrl: 'https://ai.example.com',
  })
  assert.throws(() => createPublicAiServiceConfig('http://127.0.0.1:8787'))
  assert.throws(() => createPublicAiServiceConfig(''))
})
