import type { EvaluationReport, TaskEvaluationAdapter, TaskEvaluationRequest } from '../types/taskCoordination'
import type { TaskVerificationResult } from '../types/taskOrchestration'
import { validateTaskEvaluationRequest } from '../orchestration/taskEvaluationValidation'
import { validateEvaluationReport } from '../orchestration/taskCoordinationValidation'

export type EvidenceClient = (request:TaskEvaluationRequest, signal:AbortSignal)=>Promise<TaskVerificationResult[]>
export const checkEvidence:EvidenceClient = async request=>request.task.acceptanceChecks.map((label,index)=>{
  const row=request.result.verification.find(v=>v.label===label)
  const evidence=request.result.evidence.find(e=>e.reference==='check:'+index &&
    (e.type==='user-review'||e.type==='test-log'||(e.type==='artifact' && /文件存在|非空文件/.test(label))))
  if(row?.status==='failed') return {label,status:'failed',details:'验收项记录了失败，请修改后复查。'}
  if(row?.status==='passed' && evidence) return {label,status:'passed',details:evidence.summary}
  return {label,status:'not-run',details:'缺少与本项关联的检查记录。'}
})

export class TaskEvidenceAdapter implements TaskEvaluationAdapter {
  private readonly entries=new Map<string,{signature:string; report?:EvaluationReport}>()
  constructor(private readonly client:EvidenceClient=checkEvidence){}
  async evaluate(raw:TaskEvaluationRequest,signal:AbortSignal):Promise<EvaluationReport>{
    signal.throwIfAborted()
    const checked=validateTaskEvaluationRequest(raw)
    if(!checked.ok)throw Error('评价请求无效')
    const request=structuredClone(checked.value), signature=JSON.stringify(request)
    const stored=this.entries.get(request.evaluationId)
    if(stored && stored.signature!==signature)throw Error('评价编号与原请求冲突')
    if(stored?.report)return structuredClone(stored.report)
    const entry=stored??{signature,report:undefined}
    this.entries.set(request.evaluationId,entry)
    let stop:()=>void=()=>{}
    const cancellation=new Promise<never>((_,reject)=>{
      stop=()=>reject(new DOMException('评价已取消','AbortError'))
      signal.addEventListener('abort',stop,{once:true})
    })
    const verification=await Promise.race([this.client(request,signal),cancellation])
      .finally(()=>signal.removeEventListener('abort',stop))
    signal.throwIfAborted()
    if(entry.report)return structuredClone(entry.report)
    if(verification.length!==request.task.acceptanceChecks.length || verification.some((v,i)=>v.label!==request.task.acceptanceChecks[i]))throw Error('验收项目不匹配')
    const verdict=verification.some(v=>v.status==='failed')?'revise':verification.length && verification.every(v=>v.status==='passed')?'accepted':'unknown'
    const report:EvaluationReport={evaluationId:request.evaluationId,dispatchId:request.dispatchId,taskId:request.taskId,
      verdict,verification,method:'rubric',ruleVersion:'petcast-d-1',comparisonBasis:'逐项核对验收状态与关联证据',evidence:request.result.evidence,
      note:verdict==='unknown'?'请补充检查证据。':verdict==='revise'?'请按失败项返工。':'检查项均有依据。',createdAt:new Date().toISOString()}
    if(!validateEvaluationReport(report,{taskId:request.taskId,dispatchId:request.dispatchId}).ok)throw Error('评价结果无效')
    entry.report=structuredClone(report)
    return report
  }
}

