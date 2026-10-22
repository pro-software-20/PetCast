import type { TaskRecord } from '../../electron/taskLedgerSchema'
import type { TaskEvaluation } from '../../electron/taskEvaluations'
export interface TaskFilters {search:string;model:string;category:string;status:string}
export function filterTasks(tasks:TaskRecord[],f:TaskFilters){
  const search=f.search.trim().toLocaleLowerCase()
  return tasks.filter(t=>(!search||`${t.id} ${t.label}`.toLocaleLowerCase().includes(search))&&(!f.category||t.category===f.category)&&(!f.status||t.status===f.status)&&(!f.model||t.calls.some(c=>JSON.stringify([c.provider,c.model])===f.model))).sort((a,b)=>b.endedAt.localeCompare(a.endedAt)||a.id.localeCompare(b.id))
}
/** One row per call, plus a row for tasks without calls. Unknowns stay empty, not zero. */
export function taskCsv(tasks:TaskRecord[],events:TaskEvaluation[]):string {
  const cell=(value:unknown)=>{let s=value===null||value===undefined?'':String(value);if(/^[\s]*[=+@-]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"'}
  const header=['task_id','label','category','task_status','task_ended_at','call_id','provider','model','call_status','attempt','input_tokens','output_tokens','cached_input_tokens_subset','cost','currency','cost_basis','quality','evaluation_id','comparison_key','rubric_version','price_version','price_source']
  const rows:unknown[][]=[header]
  for(const t of tasks){const last=events.filter(e=>e.source===t.source&&e.scopeId===t.scopeId&&e.taskId===t.id).at(-1)
    for(const c of t.calls.length?t.calls:[null])rows.push([t.id,t.label,t.category,t.status,t.endedAt,c?.id,c?.provider,c?.model,c?.status,c?.attempt,c?.usage?.inputTokens,c?.usage?.outputTokens,c?.usage?.cachedInputTokens,c?.cost?.amount,c?.cost?.currency,c?.cost?.basis,last?.verdict??(t.evaluation?(t.evaluation.accepted?'accepted':'revise'):'unknown'),last?.id,last?.comparisonKey??t.evaluation?.comparisonKey,last?.rubricVersion??t.evaluation?.rubricVersion,c?.cost?.pricing?.version,c?.cost?.pricing?.sourceUrl])
  }
  return '\ufeff'+rows.map(row=>row.map(cell).join(',')).join('\r\n')
}
