import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CodexAppServerSession } from '../dist-electron/codexAppServer.js'
import { createCodexScopeIdentity } from '../dist-electron/codexScopeIdentity.js'
import { readCodexQuota } from '../dist-electron/codexUsage.js'
if (process.env.PETCAST_RUN_CODEX_QUEUE_LIVE !== '1') throw Error('Explicit live check flag required')
const root = await mkdtemp(path.join(tmpdir(),'petcast-codex-live-'))
const identity = createCodexScopeIdentity(root)
const session = new CodexAppServerSession(root,identity,message=>console.log(message))
const timer = setTimeout(()=>void session.interrupt(),90000)
try {
  const quota = await readCodexQuota({scopeSalt:await identity.getSalt()})
  if(!quota.ok) throw Error('Local Codex connection failed: '+quota.code)
  await session.prepare(quota.snapshot.accountScopeId ?? quota.snapshot.scopeId, { mode: 'local-codex-experimental', transport: 'http' })
  const result = await session.run('仅回复 PETCAST_CODEX_OK，不读取文件、不修改文件、不调用工具。',60000)
  if(!result.outputText.includes('PETCAST_CODEX_OK')) throw Error('Unexpected response')
  console.log(JSON.stringify({ok:true,provider:'codex',usage:result.usage}))
} finally {
  clearTimeout(timer); session.close()
  const resolved = path.resolve(root)
  if(resolved.startsWith(path.resolve(tmpdir())+path.sep)&&path.basename(resolved).startsWith('petcast-codex-live-')) await rm(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:250}).catch(()=>console.log('Temporary directory cleanup pending; no user project was used.'))
}
