import test from 'node:test'
import assert from 'node:assert/strict'
import { loadTs } from './load-ts.mjs'

const protocol = await loadTs('../electron/customPetProtocol.ts')

test('custom pet accepts only supported image signatures and has bounded uploads', () => {
  assert.equal(protocol.detectCustomPetImageType(new Uint8Array([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])), 'png')
  assert.equal(protocol.detectCustomPetImageType(new Uint8Array([0xff,0xd8,0xff,0xe0])), 'jpeg')
  assert.equal(protocol.detectCustomPetImageType(new TextEncoder().encode('RIFF0000WEBP')), 'webp')
  assert.equal(protocol.detectCustomPetImageType(new TextEncoder().encode('<svg></svg>')), null)
  assert.equal(protocol.CUSTOM_PET_MAX_UPLOAD_BYTES, 10 * 1024 * 1024)
  assert.equal(protocol.CUSTOM_PET_MAX_DIMENSION, 2048)
})

test('custom pet IPC byte conversion rejects arbitrary values without copying valid views', () => {
  const bytes = new Uint8Array([1, 2, 3])
  assert.equal(protocol.toCustomPetBytes(bytes), bytes)
  assert.deepEqual([...protocol.toCustomPetBytes(bytes.buffer)], [1, 2, 3])
  assert.equal(protocol.toCustomPetBytes('not bytes'), null)
  assert.equal(protocol.toCustomPetBytes({ length: 3 }), null)
})
