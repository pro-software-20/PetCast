import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadTs } from './load-ts.mjs'
const { createCodexDiagnostics, copyCodexDiagnostics } = await loadTs('../electron/codexDiagnostics.ts')
const { normalizeCodexLimits } = await loadTs('../electron/codexUsage.ts')
const { CodexUsageProvider } = await loadTs('../src/usage/CodexUsageProvider.ts')
const bucket = (short, weekly) => ({ primary: {usedPercent:short, windowDurationMins:300, resetsAt:1792670000}, secondary:{usedPercent:weekly,windowDurationMins:10080,resetsAt:1793000000} })
const account={account:{type:'chatgpt',email:'fixture@example.invalid',planType:'plus',accessToken:'PRIVATE_TOKEN'}}
const limits={accountId:'private-workspace',rateLimitsByLimitId:{codex:bucket(24,6),codex_other:bucket(5,1)}}
const make=()=>createCodexDiagnostics(account,limits,'path',true)

test('separate bucket fixtures expose 76/94 versus 95/99 without substituting or averaging',()=>{
  const d=make(), snapshot=normalizeCodexLimits(limits,'scope')
  assert.deepEqual([snapshot.shortWindowRemaining,snapshot.weeklyRemaining],[76,94])
  assert.equal(d.selectedBucket,'codex')
  assert.deepEqual(d.buckets.map(b=>b.windows.map(w=>100-w.usedPercent)),[[76,94],[95,99]])
  assert.deepEqual(d.buckets[0].windows.map(w=>w.minutes),[300,10080])
})
test('diagnostics allowlist excludes full identity, credential fields and unknown plan text',()=>{
  const d=make()
  assert.equal(d.accountLabel,'f***@e***');assert.equal(d.workspaceIdentified,true)
  assert.doesNotMatch(JSON.stringify(d),/fixture|example|PRIVATE_TOKEN|private-workspace|accessToken/)
  assert.equal(createCodexDiagnostics({account:{email:'PRIVATE_TOKEN',planType:'PRIVATE_TOKEN'}},{},'desktop',false).planType,'unknown')
  const copy=copyCodexDiagnostics({...d,token:'PRIVATE_TOKEN'})
  d.buckets[0].windows[0].usedPercent=100
  assert.equal(copy.buckets[0].windows[0].usedPercent,24)
  assert.doesNotMatch(JSON.stringify(copy),/PRIVATE_TOKEN/)
})
test('partial windows remain unknown and unknown groups do not become a Codex quota',()=>{
  const d=createCodexDiagnostics(account,{rateLimitsByLimitId:{other:{primary:{windowDurationMins:15,usedPercent:null,resetsAt:null}}}},'path',false)
  assert.deepEqual(d.buckets[0].windows,[{minutes:15,usedPercent:null,resetsAt:null}])
  assert.throws(()=>normalizeCodexLimits({rateLimitsByLimitId:{other:bucket(1,2)}},'scope'))
  assert.throws(()=>copyCodexDiagnostics({...make(),accountLabel:'fixture@example.invalid'}))
})
test('mutating diagnostics returned by the provider cannot alter later source evidence',async()=>{
  let calls=0
  const raw={...normalizeCodexLimits(limits,'codex-'+'a'.repeat(64)),diagnostics:make()}
  const provider=new CodexUsageProvider({readCodexUsage:async()=>({ok:true,snapshot:{...raw,sampledAt:new Date(1792670000000+calls++*60000).toISOString()}}),cancelCodexUsage(){}})
  const first=await provider.getCurrentUsage();first.diagnostics.buckets[0].windows[0].usedPercent=100
  const second=await provider.getCurrentUsage()
  assert.equal(second.diagnostics.buckets[0].windows[0].usedPercent,24)
})
