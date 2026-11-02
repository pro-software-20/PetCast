export function normalizePublicAiServiceUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null
    return url.origin
  } catch {
    return null
  }
}

export function createPublicAiServiceConfig(value) {
  const aiApiUrl = normalizePublicAiServiceUrl(value)
  if (!aiApiUrl) throw new Error('PETCAST_PUBLIC_AI_API_URL must be a valid HTTPS origin.')
  return { version: 1, aiApiUrl }
}
