import { capabilityProblem, estimateByPrice, type TaskRequirements, type ModelCapabilities, type ModelPrice, type PlanCost } from './plannerEvidence'
import { validateTaskRecord, type TaskRecord } from '../../electron/taskLedgerSchema'
import { iso, sameScope, validateHistoryScope, type HistoryScope } from '../../electron/historySchema'

export interface PendingPlanTask extends HistoryScope {
  category:string; comparisonKey:string; method:'user'|'rubric'; rubricVersion:string
  deadlineAt:string; priority:'urgent'|'high'|'normal'|'low'; allowWait:boolean
  budget:{currency:string;amount:number}|null
  qualityPolicy?:'strict'|'recent'
  requirements?:TaskRequirements;allowEstimatedCost?:boolean;lockedModel?:{provider:string;model:string}
}
export interface ModelCapacity extends HistoryScope {
  provider:string; model:string; enabled:boolean; preference:number; checkedAt:string
  basis:'user-confirmed'|'provider-reported'
  capabilities?:ModelCapabilities;price?:ModelPrice
  capacity: {kind:'money';currency:string;remaining:number}
    | {kind:'quota';windows:{key:string;remaining:number;needed:number;resetAt:string}[]}
}
export interface ModelPlan {
  provider:string;model:string;state:'ready'|'recheck'|'blocked'|'missing'
  startAt:string|null; finishAt:string|null; latestStartAt:string|null
  durationMs:number|null;bufferMs:number|null;cost:PlanCost|null
  sampleCount:number;tokenEstimate:number|null;taskIds:string[];preference:number
  reasons:string[];limitations:string[]
}
export interface UnifiedPlan {
  state:'ready'|'recheck'|'unavailable'|'invalid'
  recommendation:ModelPlan|null;alternatives:ModelPlan[];explanation:string;warnings:string[]
}
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>=0
const currency=(v:unknown)=>typeof v==='string'&&/^[A-Z]{3}$/.test(v)
const validText=(v:unknown)=>typeof v==='string'&&v.trim().length>0&&v.length<=100
const key=(p:string,m:string)=>JSON.stringify([p,m])
const p80=(values:number[])=>[...values].sort((a,b)=>a-b)[Math.max(0,Math.ceil(values.length*.8)-1)]
/** One pending task -> ranked model/time plans. Pure function, never reserves resources or runs tasks. */
export function recommendTaskPlan(task:PendingPlanTask,input:TaskRecord[],availability:ModelCapacity[],now=Date.now()):UnifiedPlan {
  const invalid=(explanation:string):UnifiedPlan=>({state:'invalid',recommendation:null,alternatives:[],explanation,warnings:[]})
  if(!Array.isArray(input)||!Array.isArray(availability))return invalid('任务记录与模型资源必须是列表。')
  try {
    validateHistoryScope(task);iso(task.deadlineAt)
    if(task.qualityPolicy!==undefined&&!['strict','recent'].includes(task.qualityPolicy))return invalid('质量策略无效。')
    if(!Number.isFinite(now)||![task.category,task.comparisonKey,task.rubricVersion].every(validText)||!['user','rubric'].includes(task.method)||!['urgent','high','normal','low'].includes(task.priority)||typeof task.allowWait!=='boolean'||(task.budget!==null&&(!currency(task.budget.currency)||!finite(task.budget.amount))))return invalid('请补全有效的任务类型、可比任务组、评价标准、截止时间、优先级和预算。')
  }catch{return invalid('任务信息或账号作用域无效。')}
  if(Date.parse(task.deadlineAt)<=now)return invalid('截止时间已经过去，请先调整任务安排。')
  const records=new Map<string,TaskRecord>(),callIds=new Set<string>()
  try{for(const raw of input){const t=validateTaskRecord(raw)
    if(!sameScope(t,task)||Date.parse(t.endedAt)>now||Date.parse(t.endedAt)<now-90*86400000)continue
    const prior=records.get(t.id);if(prior){if(JSON.stringify(prior)!==JSON.stringify(t))throw Error('冲突');continue}
    for(const c of t.calls){if(callIds.has(c.id))throw Error('调用冲突');callIds.add(c.id)}records.set(t.id,t)
  }}catch{return invalid('历史任务记录格式或关联冲突，无法可靠生成方案。')}
  const all=[...records.values()],groups=new Map<string,TaskRecord[]>(),names=new Map<string,{provider:string;model:string}>()
  for(const t of all){const e=t.evaluation;if(t.category!==task.category||!e||e.comparisonKey!==task.comparisonKey||e.method!==task.method||e.rubricVersion!==task.rubricVersion||!t.calls.length)continue
    const models=new Set(t.calls.map(c=>key(c.provider,c.model)))
    if(models.size!==1)continue
    const c=t.calls[0],k=key(c.provider,c.model),rows=groups.get(k)??[];rows.push(t);groups.set(k,rows);names.set(k,{provider:c.provider,model:c.model})
  }
  const capacities=new Map<string,ModelCapacity>()
  for(const a of availability){if(!a||!sameScope(a,task))continue
    if(!validText(a.provider)||!validText(a.model))return invalid('候选模型标识无效。')
    const k=key(a.provider,a.model);if(capacities.has(k))return invalid('同一模型存在重复的可用额度信息，请保留最新的一份。')
    capacities.set(k,a);names.set(k,{provider:a.provider,model:a.model})
  }
  const plans:ModelPlan[]=[]
  for(const [k,name] of names){
    let rows=groups.get(k)??[]
    const a=capacities.get(k)
    if(task.qualityPolicy==='recent')rows=[...rows].sort((a,b)=>b.endedAt.localeCompare(a.endedAt)||a.id.localeCompare(b.id)).slice(0,10)
    const plan:ModelPlan={...name,state:'missing',startAt:null,finishAt:null,latestStartAt:null,durationMs:null,bufferMs:null,cost:null,sampleCount:rows.length,tokenEstimate:null,taskIds:rows.map(t=>t.id),preference:finite(a?.preference)?a!.preference:999,reasons:[],limitations:[]}
    plans.push(plan)
    if(task.lockedModel&&(name.provider!==task.lockedModel.provider||name.model!==task.lockedModel.model)){plan.state='blocked';plan.reasons.push('用户已指定其他模型；指定模型仍需通过全部约束。');continue}
    const capabilityError=capabilityProblem(task.requirements,a?.capabilities)
    if(capabilityError){plan.state='blocked';plan.reasons.push(capabilityError);continue}
    if(!task.requirements||task.requirements.contextTokens===null)plan.limitations.push('未提供本次完整上下文 Token 需求，尚未验证上下文容量。')
    if(rows.length<3){plan.reasons.push(`仅 ${rows.length} 个相同任务组、相同评价标准的已评价任务，至少需要 3 个。`);continue}
    if(task.qualityPolicy==='recent'){
      const accepted=rows.filter(t=>t.status==='succeeded'&&t.evaluation!.accepted)
      if(rows.length<5){plan.reasons.push('近期表现策略至少需要 5 个已评价任务，最多查看最近 10 个。');continue}
      if(accepted.length/rows.length<.8||rows[0].status!=='succeeded'||!rows[0].evaluation!.accepted){plan.state='blocked';plan.reasons.push('近期达标率不足 80%，或最近一次任务未达标；暂不推荐。');continue}
      plan.reasons.push(`最近 ${rows.length} 个已评价任务中 ${accepted.length} 个成功达标；当前采用用户选择的近期表现规则。`)
      plan.limitations.push('失败记录仍保留并纳入达标率。时间与费用仅参考成功达标任务，不含未来失败重做开销；80% 是产品阈值，不是质量保证。')
      rows=accepted
    }else if(rows.some(t=>t.status!=='succeeded'||!t.evaluation!.accepted)){plan.state='blocked';plan.reasons.push('可比记录中存在失败、取消或未达标结果，暂不推荐用于此任务。可在积累近期样本后手动选择近期表现策略；旧评价不删除。');continue}
    const durations=rows.map(t=>Date.parse(t.endedAt)-Date.parse(t.startedAt))
    if(durations.some(d=>d<=0)){plan.reasons.push('存在无效的零耗时记录，无法安排完成时间。');continue}
    plan.durationMs=p80(durations);plan.bufferMs=Math.max(600000,plan.durationMs*.2)
    plan.latestStartAt=new Date(Date.parse(task.deadlineAt)-plan.durationMs-plan.bufferMs).toISOString()
    const completeTokens=rows.every(t=>t.calls.every(c=>c.usage!==null))
    if(completeTokens)plan.tokenEstimate=p80(rows.map(t=>t.calls.reduce((s,c)=>s+c.usage!.inputTokens+c.usage!.outputTokens,0)))
    const completeCosts=rows.every(t=>t.calls.every(c=>c.cost?.basis==='provider-reported'))
    const currencies=new Set(rows.flatMap(t=>t.calls.filter(c=>c.cost).map(c=>c.cost!.currency)))
    if(completeCosts&&currencies.size===1)plan.cost={currency:[...currencies][0],amount:p80(rows.map(t=>t.calls.reduce((s,c)=>s+c.cost!.amount,0))),basis:'historical-reported'}
    if(task.allowEstimatedCost===true&&a?.price){
      if(task.requirements?.images){plan.reasons.push('图片计费可能包含非文本项目，本版单价估算不支持图片任务。');continue}
      const estimated=estimateByPrice(rows,a.price,now);if(!estimated.cost){plan.reasons.push(estimated.error!);continue}
      plan.cost=estimated.cost;plan.limitations.push('费用由历史实际 Token 与当前手填单价估算，不是实付账单；不含未声明的额外收费。')
    }
    if(plan.tokenEstimate===null&&plan.cost===null&&!rows.every(t=>t.quota!==null)){plan.reasons.push('缺少完整的实际 Token、实报费用或独占额度消耗，不能仅凭任务标签生成方案。');continue}
    plan.reasons.push(`${rows.length} 个可比任务均成功并达标；按耗时第 80 百分位估计 ${(plan.durationMs/60000).toFixed(1)} 分钟，再留 ${(plan.bufferMs/60000).toFixed(1)} 分钟余量。`)
    if(plan.cost)plan.reasons.push(`${plan.cost.basis==='historical-reported'?'历史实报费用':'按当前价格估算费用'}第 80 百分位 ${plan.cost.amount} ${plan.cost.currency}。`)
    else plan.limitations.push('费用数据不完整或币种不同，不按费用比较，也不推算订阅费用。')
    if(rows.some(t=>t.origin==='import'))plan.limitations.push('含用户导入记录，尚未与服务商核验。')
    plan.limitations.push('仅对已评价、同一任务组的记录作观察估计；历史表现不保证本次质量、耗时或价格。')
    if(now+plan.durationMs+plan.bufferMs>Date.parse(task.deadlineAt)){plan.state='blocked';plan.reasons.push('即使现在开始，加上预计耗时和余量也可能赶不上截止时间。');continue}
    if(task.budget&&(!plan.cost||plan.cost.currency!==task.budget.currency)){plan.reasons.push('任务设置了费用上限，但缺少同币种的费用基准（实报或用户允许的有依据估算），无法确认预算。');continue}
    if(task.budget&&plan.cost!.amount>task.budget.amount){plan.state='blocked';plan.reasons.push('费用参考估计超过本次任务费用上限。');continue}
    if(!a){plan.reasons.push('缺少这个模型当前账号的可用状态与额度确认。');continue}
    if(a.enabled!==true){plan.state='blocked';plan.reasons.push('此模型未启用或尚未确认可访问。');continue}
    if(!finite(a.preference)||!Number.isInteger(a.preference)||a.preference>999||!['user-confirmed','provider-reported'].includes(a.basis)){plan.reasons.push('模型优先级或可用状态来源无效。');continue}
    if(!Number.isFinite(Date.parse(a.checkedAt))||Date.parse(a.checkedAt)>now||now-Date.parse(a.checkedAt)>300000){plan.reasons.push('模型的可用状态已过期或时间无效，请重新确认（有效期 5 分钟）。');continue}
    if(a.basis==='user-confirmed')plan.limitations.push('当前可用状态 / 预算由用户确认，未自动查询服务商。')
    let start=now,conditional=false
    if(a.capacity?.kind==='money'){
      if(!finite(a.capacity.remaining)||!currency(a.capacity.currency)){plan.reasons.push('可用费用预算无效。');continue}
      if(!plan.cost||a.capacity.currency!==plan.cost.currency){plan.reasons.push('缺少与可用预算同币种的实际费用或获准估算基准，不跨币种折算。');continue}
      if(plan.cost.amount>a.capacity.remaining){plan.state='blocked';plan.reasons.push('费用参考估计超过当前可用预算。');continue}
      plan.reasons.push(`当前确认可用预算 ${a.capacity.remaining} ${a.capacity.currency}，覆盖费用参考估计。`)
    }else if(a.capacity?.kind==='quota'){
      const windows=a.capacity.windows
      if(!Array.isArray(windows)||!windows.length||windows.length>8||windows.some(w=>!w||!validText(w.key)||![w.remaining,w.needed].every(n=>finite(n)&&n<=100))||new Set(windows.map(w=>w.key)).size!==windows.length){plan.reasons.push('额度窗口或预计用量不完整 / 无效。');continue}
      // Codex is constrained by both windows; omitting one must never make a plan appear feasible.
      if(a.provider.toLowerCase()==='codex'&&(!windows.some(w=>w.key==='short')||!windows.some(w=>w.key==='weekly'))){plan.reasons.push('Codex 需要同时提供短周期与周额度窗口。');continue}
      const lacking=windows.filter(w=>w.needed>w.remaining)
      if(lacking.length){
        if(task.priority==='urgent'||!task.allowWait){plan.state='blocked';plan.reasons.push('当前额度不足，且任务紧急或不允许等待。');continue}
        if(lacking.some(w=>!Number.isFinite(Date.parse(w.resetAt))||Date.parse(w.resetAt)<=now)){plan.reasons.push('不足窗口的恢复时间未知或已经过去，需要刷新额度。');continue}
        start=Math.max(...lacking.map(w=>Date.parse(w.resetAt)));conditional=true
        plan.reasons.push(`等待 ${lacking.map(w=>w.key).join('、')} 窗口最晚恢复时间后重新读取，确认全部窗口满足预算。`)
        plan.limitations.push('恢复时间不保证额度到位；这是一项有条件方案，不能直接作为确定的执行时间。')
      }else plan.reasons.push('所有已声明的额度窗口均覆盖填写的任务预算。')
      plan.limitations.push('各窗口预计消耗为任务预算，不能把不同平台的额度百分点互相比较。')
    }else{plan.reasons.push('缺少支持的预算 / 额度信息。');continue}
    const finish=start+plan.durationMs+plan.bufferMs
    if(plan.cost?.basis==='current-price-estimate'&&a.price&&Date.parse(a.price.validUntil)<=finish){plan.reasons.push('价格有效期不能覆盖预计执行区间，请更新价格或调整安排。');continue}
    if(finish>Date.parse(task.deadlineAt)){plan.state='blocked';plan.reasons.push('考虑额度等待、预计耗时和余量后，可能超过截止时间。');continue}
    plan.startAt=new Date(start).toISOString();plan.finishAt=new Date(finish).toISOString();plan.state=conditional?'recheck':'ready'
  }
  const feasible=plans.filter(p=>p.state==='ready'||p.state==='recheck'),fast=task.priority==='urgent'||task.priority==='high'
  const comparable=feasible.length>0&&feasible.every(p=>p.cost!==null)&&new Set(feasible.map(p=>p.cost!.currency)).size===1
  feasible.sort((a,b)=>{
    if(fast){const ready=Number(a.state!=='ready')-Number(b.state!=='ready');if(ready)return ready;const finish=Date.parse(a.finishAt!)-Date.parse(b.finishAt!);if(finish)return finish}
    if(comparable&&a.cost!.amount!==b.cost!.amount)return a.cost!.amount-b.cost!.amount
    const finish=Date.parse(a.finishAt!)-Date.parse(b.finishAt!);if(finish)return finish
    return a.preference-b.preference||key(a.provider,a.model).localeCompare(key(b.provider,b.model))
  })
  const recommendation=feasible[0]??null
  const explanation=!recommendation?'没有同时满足质量、截止时间与资源约束的候选；下方列出每个模型缺少的信息或被排除的原因。':fast?'优先级较高：先考虑当前可行方案，再优先较早完成；费用与用户模型优先级用于后续比较。':comparable?'质量与截止时间通过后，优先费用参考估计较低的方案，再比较完成时间与用户模型优先级。':'候选费用缺失或币种不同，无法判定哪个更省；按预计完成时间及用户模型优先级选择。'
  return {state:recommendation?(recommendation.state==='ready'?'ready':'recheck'):'unavailable',recommendation,alternatives:[...feasible.slice(1),...plans.filter(p=>p.state==='missing'||p.state==='blocked')],explanation,warnings:[...(new Set(feasible.map(p=>p.cost?.basis)).size>1?['候选费用包含历史实报与当前价格估算两种依据，比较仅作参考，不代表已实现的节省。']:[]),'这是单任务综合推荐，不会预留额度、自动调用模型或创建定时任务。多个任务同时执行时需由执行器做资源预留并重新评估。','只使用当前账号独立查询的近期历史（最多 90 天）；质量策略、样本门槛与第 80 百分位是产品规则，不是统计保证。']}
}
