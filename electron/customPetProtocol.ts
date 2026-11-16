export const CUSTOM_PET_MAX_UPLOAD_BYTES = 10 * 1024 * 1024
export const CUSTOM_PET_MAX_DIMENSION = 2048
export const CUSTOM_PET_MAX_DECODED_DIMENSION = 8192

export type CustomPetAsset = {
  dataUrl: string
  width: number
  height: number
  revision: string
}

export type CustomPetResult =
  | { ok: true; asset: CustomPetAsset | null }
  | { ok: false; code: 'INVALID_IMAGE' | 'TOO_LARGE' | 'UNAVAILABLE'; message: string }

export function detectCustomPetImageType(bytes: Uint8Array): 'png' | 'jpeg' | 'webp' | null {
  if (bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  if (bytes.length >= 12
    && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF'
    && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') return 'webp'
  return null
}

export function toCustomPetBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  return null
}
