import { useState } from 'react'
import type { EvaluationEvidenceRef } from '../types/taskCoordination'

export function TaskEvidencePanel({checks,changedFiles,disabled,onRequest}:{
  checks:string[]; changedFiles:string[]; disabled:boolean; onRequest:(evidence:EvaluationEvidenceRef[])=>void
}){
  const [notes,setNotes]=useState<Record<number,string>>({})
  const [files,setFiles]=useState<Record<number,string>>({})
  const [error,setError]=useState('')
  function submit(){
    const evidence:EvaluationEvidenceRef[]=Object.entries(notes).filter(([,s])=>s.trim()).map(([i,s])=>({type:'user-review',reference:'check:'+i,summary:s.trim()}))
    for(const [i,summary] of Object.entries(files)) evidence.push({type:'artifact',reference:'check:'+i,summary})
    onRequest(evidence)
  }
  return <div>{!disabled&&<details><summary>补充检查证据</summary>{checks.map((label,i)=><label key={i}>{label}
    <input maxLength={180} value={notes[i]??''} placeholder="填写已核对的结果" onChange={e=>setNotes({...notes,[i]:e.target.value})}/>
    {changedFiles.length>0&&<input type="file" aria-label={'核对文件 '+label} onChange={e=>{
      const f=e.target.files?.[0];if(!f)return
      if(!f.size||changedFiles.filter(p=>p.split('/').pop()===f.name).length!==1){
        setError('请选择结果中唯一匹配的非空文件');setFiles(prev=>{const copy={...prev};delete copy[i];return copy});return
      }
      setError('');setFiles(prev=>({...prev,[i]:'文件名匹配，大小 '+f.size+' 字节'}))
    }}/>}</label>)}{error&&<p role="alert">{error}</p>}</details>}
    <button type="button" disabled={disabled} onClick={submit}>请求评价</button></div>
}
