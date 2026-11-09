import { useMemo,useState } from 'react'
import type { ReportQuery } from '../history/usageMetrics'
import { appendResourceSamples,listResources,type ResourceSample } from '../reports/resourceHistory'
export function ResourceOverview({query,demo,revision,latest}:{latest?:import('../types/usageHistory').UsageSample;query:ReportQuery;demo:boolean;revision:number}){
  const [notice,setNotice]=useState('')
  const result=useMemo(()=>{
    try{
      const common={source:query.source,scopeId:query.scopeId,account:'示例账号',at:new Date(Date.parse(query.endAt)-1000).toISOString()}
      const samples:ResourceSample[]=[{...common,provider:'示例平台 A',kind:'quota-percent',unit:'%',value:64},{...common,provider:'示例平台 B',kind:'balance',unit:'CNY',value:12.6}]
      const rows=listResources(query,demo?samples:undefined)
      if(!demo && latest) {
        for(const [label,value] of [['5 小时',latest.shortWindowRemaining],['周',latest.weeklyRemaining]] as const)
          rows.unshift({...common,provider:latest.source==='real'?'Codex':'模拟额度',account:label,kind:'quota-percent',unit:'%',value,at:latest.sampledAt})
      }
      return {rows}
    }catch{return {error:'资源历史读取失败，请检查原记录。'}}
  },[query,demo,revision,latest])
  async function load(file:File){
    try{
      if(file.size>2e6)throw Error('文件过大')
      const doc=JSON.parse(await file.text())
      if(doc.version!==1||!Array.isArray(doc.samples)||doc.samples.length===0||doc.samples.length>1000)throw Error('需要含 samples 列表的 v1 资源文件')
      await appendResourceSamples(query,doc.samples);setNotice('已导入 '+doc.samples.length+' 条采样')
    }catch(e){setNotice(e instanceof Error?e.message:'导入失败')}
  }
  return <details className="history-chart"><summary>平台资源 · 期内最近采样</summary>
    {result.error||(!result.rows?.length?'暂无平台采样':result.rows.map(r=><p key={JSON.stringify([r.provider,r.account,r.kind,r.unit])}>{r.provider} · {r.account} · {r.kind==='balance'?'余额':'剩余额度'} {r.value} {r.unit} · {new Date(r.at).toLocaleString('zh-CN',{timeZone:query.timeZone})}</p>))}
    {!demo&&<label>导入资源采样 <input type="file" accept=".json" onChange={e=>{const f=e.target.files?.[0];if(f)void load(f);e.target.value=''}}/></label>}
    {!demo&&<details><summary>采样导入格式</summary><pre style={{whiteSpace:'pre-wrap'}}>{JSON.stringify({version:1,samples:[{source:query.source,scopeId:query.scopeId,provider:'平台名称',account:'账号别名',kind:'balance',unit:'CNY',value:12.6,at:query.startAt}]},null,2)}</pre></details>}
    {notice&&<p role="status">{notice}</p>}
  </details>
}

