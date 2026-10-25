import { createHmac, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

export function createCodexScopeIdentity(userData: string) {
  let saltPromise: Promise<string> | undefined
  const getSalt = () => saltPromise ??= (async () => {
    const file = path.join(userData, 'codex-scope-salt')
    await fs.mkdir(userData, { recursive: true })
    await fs.writeFile(file, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 })
      .catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
    const value = (await fs.readFile(file, 'utf8')).trim()
    if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid scope salt')
    return value
  })().catch(error => {
    saltPromise = undefined
    throw error
  })

  const hashAccount = async (email: string, accountId?: string) => {
    const normalizedEmail = email.trim().toLowerCase()
    const material = accountId ? JSON.stringify([normalizedEmail, accountId]) : normalizedEmail
    return `codex-${createHmac('sha256', await getSalt()).update(material).digest('hex')}`
  }

  const hashSubject = async (subject: string, clientId: string) => {
    const material = JSON.stringify(['chatgpt-oauth', subject.trim(), clientId.trim()])
    return `codex-${createHmac('sha256', await getSalt()).update(material).digest('hex')}`
  }

  return { getSalt, hashAccount, hashSubject }
}

export type CodexScopeIdentity = ReturnType<typeof createCodexScopeIdentity>
