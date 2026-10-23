import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadTs } from './load-ts.mjs'
const { BrowserUsageHistoryStore, DesktopUsageHistoryStore, HISTORY_STORAGE_KEY } = await loadTs('../src/history/UsageHistoryStore.ts')
const { FileUsageHistoryStore } = await loadTs('../electron/historyStore.ts')
const { pruneHistory, validateHistorySample, validateHistoryQuery } = await loadTs('../electron/historySchema.ts')
const now = Date.parse('2026-10-21T00:00:00.000Z')
const scope = {source: 'real', scopeId: `codex-${'a'.repeat(64)}`}
const other = {source: 'real', scopeId: `codex-${'b'.repeat(64)}`}
const mock = {source: 'mock', scopeId: 'mock-local'}
const sample = (minutes = 0, extra = {}) => ({...scope, id: `s-${minutes}`, sampledAt: new Date(now - 3600000 + minutes*60000).toISOString(), shortWindowRemaining: 80, weeklyRemaining: 70, burnRate: null, shortWindowResetAt: new Date(now+3600000).toISOString(), weeklyResetAt: new Date(now+86400000).toISOString(), ...extra})
const query = (s = scope) => ({...s, startAt: new Date(now-86400000).toISOString(), endAt: new Date(now).toISOString()})
const memory = () => { const map = new Map(); return {getItem: key => map.get(key) ?? null, setItem: (key,v) => {map.set(key,v)}} }
for (const kind of ['browser','file']) {
  const setup = async () => {
    if (kind === 'browser') { const storage = memory(); return {store: new BrowserUsageHistoryStore(storage,()=>now), reopen: () => new BrowserUsageHistoryStore(storage,()=>now), corrupt: () => storage.setItem(HISTORY_STORAGE_KEY,'broken'), raw: () => storage.getItem(HISTORY_STORAGE_KEY)} }
    const dir = await mkdtemp(path.join(tmpdir(),'petcast-history-test-')), file = path.join(dir,'history.json')
    return {store: new FileUsageHistoryStore(file,()=>now), reopen: () => new FileUsageHistoryStore(file,()=>now), corrupt: () => writeFile(file,'broken'), raw: () => readFile(file,'utf8'), dir}
  }
  test(`${kind}: restart, timestamp dedup, sorted half-open query and source/account isolation`, async () => {
    const {store,reopen} = await setup()
    await Promise.all([store.appendUsageSample(sample(3)),store.appendUsageSample(sample()),store.appendUsageSample(sample(1))])
    await store.appendUsageSample(sample(1,{id:'another-id',shortWindowRemaining:0}))
    await store.appendUsageSample(sample(1,other)); await store.appendUsageSample(sample(1,mock))
    const result = await reopen().queryUsageSamples({...query(),endAt:sample(3).sampledAt})
    assert.equal(result.length,2); assert.equal(result[1].shortWindowRemaining,80)
    assert.equal(result[0].sampledAt,sample().sampledAt)
    assert.equal((await store.queryUsageSamples(query(other))).length,1)
    await store.clearUsageHistory(scope)
    assert.equal((await store.queryUsageSamples(query())).length,0)
    assert.equal((await store.queryUsageSamples(query(mock))).length,1)
    assert.equal((await store.queryUsageSamples(query(other))).length,1)
  })
  test(`${kind}: corrupt history is an error; append and clear preserve it`, async () => {
    const s = await setup(); await s.corrupt()
    await assert.rejects(s.store.queryUsageSamples(query()))
    await assert.rejects(s.store.appendUsageSample(sample()))
    await assert.rejects(s.store.clearUsageHistory(scope))
    assert.equal(await s.raw(),'broken')
  })
  test(`${kind}: invalid write does not poison the serialized queue`, async () => {
    const {store,dir} = await setup()
    await assert.rejects(store.appendUsageSample(sample(0,{shortWindowRemaining:101})))
    await store.appendUsageSample(sample())
    assert.equal((await store.queryUsageSamples(query())).length,1)
    if (dir) assert.deepEqual(await readdir(dir),['history.json'])
  })
}
test('retention removes expired entries before keeping latest 100,000 separately for each scope', () => {
  const records = Array.from({length:100005},(_,i)=>sample(0,{sampledAt:new Date(now-100005+i).toISOString(),id:`s-${i}`}))
  records.push(sample(0,{sampledAt:new Date(now-91*86400000).toISOString()}),sample(0,other))
  const result = pruneHistory(records,now)
  assert.equal(result.filter(s=>s.scopeId===scope.scopeId).length,100000)
  assert.equal(result.filter(s=>s.scopeId===other.scopeId).length,1)
  assert.equal(result[0].id,'s-5')
})
test('schema rejects identities, malformed dates, invalid rates and excessive query ranges', () => {
  for (const extra of [{scopeId:'a@example.com'},{source:'unknown'},{sampledAt:'2026-02-30T00:00:00.000Z'},{burnRate:Infinity},{weeklyRemaining:-1}]) assert.throws(()=>validateHistorySample(sample(0,extra)))
  assert.throws(()=>validateHistoryQuery({...query(),startAt:'2020-01-01T00:00:00.000Z'}))
})
test('browser storage-full errors are visible and leave previous data intact', async () => {
  const storage = memory(), store = new BrowserUsageHistoryStore(storage,()=>now)
  await store.appendUsageSample(sample()); const original = storage.getItem(HISTORY_STORAGE_KEY)
  storage.setItem = () => { throw Error('quota exceeded') }
  await assert.rejects(store.appendUsageSample(sample(1)))
  assert.equal(storage.getItem(HISTORY_STORAGE_KEY),original)
})
test('desktop missing bridge fails explicitly; no fallback to browser storage', async () => {
  const store = new DesktopUsageHistoryStore({})
  await assert.rejects(store.appendUsageSample(sample()),/接口不可用/)
  await assert.rejects(store.queryUsageSamples(query()),/接口不可用/)
  await assert.rejects(store.clearUsageHistory(scope),/接口不可用/)
})
