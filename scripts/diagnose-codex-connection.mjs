// Print allowlisted diagnostics only: no prompts, credentials or raw upstream errors.
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CodexAppServerSession } from '../dist-electron/codexAppServer.js'
import { createCodexScopeIdentity } from '../dist-electron/codexScopeIdentity.js'
import { readCodexQuota, resolveCodexExecutable } from '../dist-electron/codexUsage.js'
const live = process.argv.includes('--live')
const safeMessage = value => typeof value !== 'string' ? undefined : value
  .replace(/https?:\/\/[^\s"<>]+/gi, '[service URL]')
  .replace(/[A-Za-z]:[\\/][^\s"<>]+/g, '[local path]')
  .replace(/[\w.+-]+@[\w.-]+/g, '[account]')
  .replace(/(?:Bearer\s+|sk-)[^\s"<>]+/gi, '[credential]')
  .replace(/[A-Za-z0-9_\/.+=-]{32,}/g, '[identifier]').slice(0,800)
if (live && process.env.PETCAST_RUN_CODEX_QUEUE_LIVE !== '1') throw Error('Explicit live check flag required')
const root = await mkdtemp(path.join(tmpdir(), 'petcast-codex-diagnosis-'))
const identity = createCodexScopeIdentity(root)
const resolved = await resolveCodexExecutable()
console.log(JSON.stringify({source: resolved.source, binaryVersion: execFileSync(resolved.executable,['--version'],{encoding:'utf8',windowsHide:true}).trim()}))
const facts = value => {
  const str = typeof value === 'string' ? value : JSON.stringify(value)
  const markers = ['websocket','certificate','tls','ssl','timeout','timed out','proxy','unauthorized','forbidden','model_not_found','unsupported_country','connection reset','connection refused','dns','failed to connect','network is unreachable','403','401','400','502','503','429'].filter(term=>str.toLowerCase().includes(term))
  const hosts = [...str.matchAll(/https?:\/\/([^\s/"<>]+)/g)].map(match=>{
    try { return new URL('https://'+match[1]).hostname } catch { return 'invalid' }
  }).filter(host=>/^[a-z0-9.-]+$/i.test(host))
  return {markers,hosts:[...new Set(hosts)]}
}
const session = new CodexAppServerSession(root,identity,message=>console.log(message), (exe,cwd,args,env)=>{
  const child = spawn(exe,args,{cwd,env,windowsHide:true,stdio:['pipe','pipe','pipe']})
  let buffer=''
  child.stdout.on('data',chunk=>{
    buffer+=chunk.toString(); let index
    while((index=buffer.indexOf('\n'))>=0){
      const line=buffer.slice(0,index);buffer=buffer.slice(index+1)
      try { const msg=JSON.parse(line)
        if(msg.method==='error') {
          console.log(JSON.stringify({upstreamError:facts(msg.params?.error),message:safeMessage(msg.params?.error?.message),willRetry:msg.params?.willRetry,info: typeof msg.params?.error?.codexErrorInfo==='string' ? msg.params.error.codexErrorInfo : Object.keys(msg.params?.error?.codexErrorInfo??{}),httpStatus:Object.values(msg.params?.error?.codexErrorInfo??{}).find(v=>typeof v?.httpStatusCode==='number')?.httpStatusCode}))
          if(process.argv.includes('--stop-on-error')) queueMicrotask(()=>void session.interrupt())
        }
      }catch{}
    }
  })
  let diagnosticCount=0
  child.stderr.on('data',chunk=>{const safe=facts(chunk.toString());if(diagnosticCount++<8) console.log(JSON.stringify({stderr:safe,message:safeMessage(chunk.toString())}))})
  return child
})
const timer=setTimeout(()=>void session.interrupt(),live?100000:60000)
try{
 const quota=await readCodexQuota({scopeSalt:await identity.getSalt()})
 if(!quota.ok) throw Error('Quota:'+quota.code)
 const model=await session.prepare(quota.snapshot.accountScopeId??quota.snapshot.scopeId, { mode:'local-codex-experimental', transport:process.argv.includes('--http')?'http':'default' })
 const models=await session.request('model/list',{limit:100,includeHidden:false})
 console.log(JSON.stringify({selectedModel:model,models:models.data?.map(m=>({model:m.model,isDefault:m.isDefault,effort:m.defaultReasoningEffort}))}))
 if(live){const result=await session.run('仅回复 PETCAST_CODEX_OK，不读取文件、不修改文件、不调用工具。',60000);console.log(JSON.stringify({ok:result.outputText.includes('PETCAST_CODEX_OK'),usage:result.usage}))}
}catch(error){console.log(JSON.stringify({ok:false,error:error.code??'DIAGNOSIS_FAILED'}));process.exitCode=1}
finally {clearTimeout(timer);session.close();const resolvedRoot=path.resolve(root);if(path.dirname(resolvedRoot)===path.resolve(tmpdir())&&path.basename(resolvedRoot).startsWith('petcast-codex-diagnosis-'))await rm(resolvedRoot,{recursive:true,force:true,maxRetries:5,retryDelay:200}).catch(()=>{})}
