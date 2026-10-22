import { useState } from 'react'
import type { TaskLedger, TaskRecord, TaskEvaluation } from '../history/TaskLedger'
export function TaskEvaluationForm({task,events,ledger}:{task:TaskRecord;events:TaskEvaluation[];ledger:TaskLedger}){
  const history=events.filter(e=>e.source===task.source&&e.scopeId===task.scopeId&&e.taskId===task.id),last=history.at(-1)
  const [comparison,setComparison]=useState(last?.comparisonKey??task.evaluation?.comparisonKey??'')
  const [rubric,setRubric]=useState(last?.rubricVersion??task.evaluation?.rubricVersion??'用户验收-v1')
  const [verdict,setVerdict]=useState<TaskEvaluation['verdict']>(last?.verdict??(task.evaluation?(task.evaluation.accepted?'accepted':'revise'):'unknown'))
  const [note,setNote]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState('')
  async function save(){setBusy(true);setMessage('');try{
    await ledger.appendTaskEvaluations([{source:task.source,scopeId:task.scopeId,id:crypto.randomUUID(),taskId:task.id,createdAt:new Date().toISOString(),supersedes:last?.id??null,comparisonKey:comparison.trim(),rubricVersion:rubric.trim(),method:'user',verdict,note:note.trim()}])
    setMessage('评价已保存，原调用记录未修改。')
  }catch{setMessage('评价未保存：请填写任务组和标准；若其他页面已更新，请刷新后再提交。')}finally{setBusy(false)}}
  return <details className="task-evaluation"><summary>评价结果与修订历史（{history.length} 次追加）</summary>
    <p>将规模、要求相近的任务放入同一任务组，并使用相同验收标准；“无法判断”不计为达标。</p>
    <div className="history-filters"><label>可比任务组<input aria-label={`评价任务组 ${task.id}`} maxLength={100} value={comparison} onChange={e=>setComparison(e.target.value)}/></label>
    <label>评价标准版本<input aria-label={`评价标准 ${task.id}`} maxLength={100} value={rubric} onChange={e=>setRubric(e.target.value)}/></label>
    <label>结论<select aria-label={`评价结论 ${task.id}`} value={verdict} onChange={e=>setVerdict(e.target.value as TaskEvaluation['verdict'])}><option value="unknown">无法判断</option><option value="accepted">达标</option><option value="revise">需修改</option></select></label>
    <label>说明（选填）<input aria-label={`评价说明 ${task.id}`} maxLength={500} value={note} onChange={e=>setNote(e.target.value)}/></label>
    <button aria-label={`保存评价 ${task.id}`} disabled={busy||!comparison.trim()||!rubric.trim()} onClick={()=>void save()}>保存评价</button></div>
    {message&&<p role="status">{message}</p>}
    {task.evaluation&&<p>完成时评价：{task.evaluation.accepted?'达标':'未达标'} · {task.evaluation.method} · {task.evaluation.rubricVersion}</p>}
    <ol>{history.map(e=><li key={e.id}>{new Date(e.createdAt).toLocaleString('zh-CN')} · {{accepted:'达标',revise:'需修改',unknown:'无法判断'}[e.verdict]} · {e.method==='user'?'人工评价':'规则评价'} · {e.comparisonKey} / {e.rubricVersion}{e.note&&` · ${e.note}`}<details><summary>追溯标识</summary><small>评价 {e.id}{e.supersedes&&`，修订 ${e.supersedes}`}</small></details></li>)}</ol>
  </details>
}
