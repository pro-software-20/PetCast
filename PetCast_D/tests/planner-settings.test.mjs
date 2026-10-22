import {test} from 'node:test'
import assert from 'node:assert/strict'
import {loadTs} from './load-ts.mjs'
const {savePlannerSettings,loadPlannerSettings,plannerSettingsKey}=await loadTs('../src/reports/plannerSettings.ts')
const scope={source:'mock',scopeId:'mock-settings'},key=JSON.stringify(['provider','model'])
const config={kind:'money',currency:'USD',preference:2,images:true,tools:false,context:'8192',priceEnabled:true,priceSource:'https://example.com/pricing',priceVersion:'v1',priceFrom:'2026-10-22T00:00',priceUntil:'2026-11-01T00:00',inputPrice:'1',cachedPrice:'0.1',outputPrice:'3',standardBilling:true,budget:'100',short:'50',weekly:'50',checkedAt:'2026-10-22T00:00:00.000Z'}
test('restores stable settings only, isolates accounts and never resurrects resource confirmation',()=>{
  const data=new Map(),storage={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v)}
  savePlannerSettings(storage,scope,{[key]:config});const restored=loadPlannerSettings(storage,scope)[key]
  assert.equal(restored.context,'8192');assert.equal(restored.priceVersion,'v1');assert.equal(restored.preference,2)
  for(const k of ['budget','short','weekly','checkedAt'])assert.equal(restored[k],undefined)
  assert.deepEqual(loadPlannerSettings(storage,{...scope,scopeId:'mock-other'}),{})
  data.set(plannerSettingsKey(scope),'broken');assert.throws(()=>loadPlannerSettings(storage,scope));assert.equal(data.get(plannerSettingsKey(scope)),'broken')
})
test('rejects malformed settings without replacing stored configuration',()=>{
  let writes=0;const storage={setItem:()=>writes++}
  assert.throws(()=>savePlannerSettings(storage,scope,{[key]:{...config,preference:-1}}));assert.equal(writes,0)
  assert.throws(()=>savePlannerSettings(storage,scope,{'bad-key':config}));assert.equal(writes,0)
})
