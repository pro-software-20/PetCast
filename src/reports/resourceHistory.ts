import type { HistoryScope, HistoryQuery } from '../../electron/historySchema'
export type ResourceSample = HistoryScope & {provider:string;account:string;kind:'quota-percent'|'tokens'|'balance';unit:string;value:number;at:string}
const prefix='petcast.d.resources.v1.'
const key=(s:HistoryScope)=>prefix+JSON.stringify([s.source,s.scopeId])
function checked(item:ResourceSample,scope:HistoryScope) {
  if(!item || item.source!==scope.source || item.scopeId!==scope.scopeId || ![item.provider,item.account,item.unit].every(x=>typeof x==='string' && x.trim().length>0 && x.length<=80) ||
    typeof item.at!=='string' || !Number.isFinite(Date.parse(item.at)) || new Date(item.at).toISOString()!==item.at ||
    !Number.isFinite(item.value)||item.value<0 ||
    !(item.kind==='quota-percent' && item.unit==='%' && item.value<=100 || item.kind==='tokens' && item.unit==='Token' && Number.isSafeInteger(item.value) || item.kind==='balance' && /^[A-Z]{3}$/.test(item.unit))) throw Error('资源记录的账号、数值或单位无效')
  return {source:scope.source,scopeId:scope.scopeId,provider:item.provider,account:item.account,kind:item.kind,unit:item.unit,value:item.value,at:item.at}
}
function read(scope:HistoryScope) {
  const rows:unknown=JSON.parse(localStorage.getItem(key(scope))??'[]')
  if(!Array.isArray(rows))throw Error('资源历史读取失败')
  return rows.map(r=>checked(r,scope))
}
export async function appendResourceSamples(scope:HistoryScope,samples:ResourceSample[]){
  const incoming=samples.map(s=>checked(s,scope))
  const write=()=>{
    const rows=new Map<string,ResourceSample>()
    for(const s of [...read(scope),...incoming]){
      const id=JSON.stringify([s.provider,s.account,s.kind,s.unit,s.at])
      if(rows.has(id)&&rows.get(id)!.value!==s.value)throw Error('同一次采样存在冲突')
      rows.set(id,s)
    }
    localStorage.setItem(key(scope),JSON.stringify([...rows.values()].sort((a,b)=>a.at.localeCompare(b.at)).slice(-20000)))
  }
  if(navigator.locks)await navigator.locks.request(key(scope),write);else write()
  window.dispatchEvent(new Event('petcast:task-ledger-changed'))
}
export function listResources(query:HistoryQuery,samples=read(query)){
  const latest=new Map<string,ResourceSample>()
  for(const row of samples.filter(s=>s.source===query.source&&s.scopeId===query.scopeId&&s.at>=query.startAt&&s.at<query.endAt)){
    const id=JSON.stringify([row.provider,row.account,row.kind,row.unit])
    if(!latest.has(id)||latest.get(id)!.at<row.at)latest.set(id,row)
  }
  return [...latest.values()]
}

