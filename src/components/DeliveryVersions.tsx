import { useState } from 'react'
type Version={body:string;created:string}
type Archive={active:number;versions:Version[]}
function read(key:string,initial:string):Archive {
  const raw=localStorage.getItem(key)
  if(!raw)return {active:0,versions:[{body:initial,created:new Date().toISOString()}]}
  const a=JSON.parse(raw)
  if(!Array.isArray(a.versions)||!a.versions.length||!a.versions.every((v:Version)=>v&&typeof v.body==='string'&&typeof v.created==='string')||!Number.isInteger(a.active)||!a.versions[a.active])throw Error('成果存档无法读取')
  return a
}
const archivePrefix=(owner:string)=>'petcast.delivery.v1.'+encodeURIComponent(owner)+':'
export function DeliveryLibrary({owner}:{owner:string}){
  const [items,setItems]=useState<{id:string;title:string}[]>([])
  const [error,setError]=useState('')
  function refresh(){
    try{
      const prefix=archivePrefix(owner), found=[]
      for(let i=0;i<localStorage.length;i++){
        const k=localStorage.key(i)
        if(k?.startsWith(prefix)){
          const record=JSON.parse(localStorage.getItem(k)!)
          found.push({id:k.slice(prefix.length),title:String(record.title??'已归档成果')})
        }
      }
      setItems(found);setError('')
    }catch{setError('部分成果索引无法读取')}
  }
  return <details className="history-chart" onToggle={e=>{if(e.currentTarget.open)refresh()}}><summary>已归档成果</summary>{error&&<p role="alert">{error}</p>}{!items.length&&<p>暂无已归档成果</p>}{items.map(i=><DeliveryVersions key={i.id} owner={owner} id={i.id} title={i.title} initial=""/>)}</details>
}
export function DeliveryVersions({id,title,initial,owner='local'}:{id:string;title:string;initial:string;owner?:string}) {
  const key=archivePrefix(owner)+id
  const [archive,setArchive]=useState<Archive|null>(()=>{try{return id==='isolated-demo'?{active:0,versions:[{body:initial,created:new Date().toISOString()}]}:read(key,initial)}catch{return null}})
  const [preview,setPreview]=useState(false)
  const [edit,setEdit]=useState<string|null>(null),[compare,setCompare]=useState<number|null>(null),[message,setMessage]=useState('')
  if(!archive)return <p role="alert">成果存档读取失败，请保留原记录。</p>
  const current=archive.versions[archive.active]
  const previewPolicy="<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'\">"
  const html=current.body.match(/(?:^```html\s*\n)([\s\S]*?)^```/im)?.[1]??(/^\s*(?:<!doctype html|<html)[\s>]/i.test(current.body)?current.body:null)
  async function save(next:Archive){
    const write=()=>{
      if(id!=='isolated-demo'){
        const existing=localStorage.getItem(key)
        if(existing){
          const latest=read(key,initial)
          if(JSON.stringify([latest.active,latest.versions])!==JSON.stringify([archive!.active,archive!.versions])){
            setArchive(latest);setMessage('另一窗口已更新成果，请核对后重新保存。');return
          }
        }
        localStorage.setItem(key,JSON.stringify({...next,title}))
      }
      setArchive(next);setEdit(null);setMessage('已保存')
    }
    try{if(navigator.locks)await navigator.locks.request(key,write);else write()}
    catch{setMessage('保存失败，请先导出成果。')}
  }
  function download(){
    const url=URL.createObjectURL(new Blob([current.body],{type:'text/plain;charset=utf-8'}))
    const a=document.createElement('a');a.href=url;a.download=title.replace(/[<>:"/\\|?*]/g,'_').slice(0,80)+'-v'+(archive!.active+1)+'.md';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)
  }
  return <details className="history-chart"><summary>{title} · 成果版本 {archive.active+1}</summary>
    <pre style={{whiteSpace:'pre-wrap',maxHeight:220,overflow:'auto'}}>{current.body}</pre>
    {html&&<><button onClick={()=>setPreview(v=>!v)}>{preview?'关闭预览':'预览 HTML'}</button>{preview&&<iframe sandbox="" referrerPolicy="no-referrer" title="HTML 成果预览" srcDoc={previewPolicy+html}/>}</>}
    <button onClick={()=>save(archive)}>归档当前成果</button> <button onClick={download}>导出当前版本</button> <button onClick={()=>setEdit(current.body)}>录入修订版</button>{initial&&initial!==current.body&&<button onClick={()=>setEdit(initial)}>载入任务最新结果</button>}
    {edit!==null&&<div><textarea aria-label="修订后的成果" value={edit} onChange={e=>setEdit(e.target.value)}/><button disabled={!edit.trim()||edit===current.body} onClick={()=>save({active:archive.versions.length,versions:[...archive.versions,{body:edit,created:new Date().toISOString()}]})}>保存新版本</button><button onClick={()=>setEdit(null)}>取消</button></div>}
    {archive.versions.length>1&&<div><label>对比版本 <select value={compare??''} onChange={e=>setCompare(e.target.value===''?null:Number(e.target.value))}><option value="">选择历史版本</option>{archive.versions.map((_,i)=><option key={i} value={i}>版本 {i+1}</option>)}</select></label>
      {compare!==null&&archive.versions[compare]&&<><p>版本 {compare+1} 原文（当前版本见上方）</p><pre style={{whiteSpace:'pre-wrap'}}>{archive.versions[compare].body}</pre><button disabled={compare===archive.active} onClick={()=>save({...archive,active:compare})}>恢复此版本</button></>}
    </div>}<small role="status">{message}</small>
  </details>
}

