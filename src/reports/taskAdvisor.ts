import type { TaskRecord } from '../../electron/taskLedgerSchema'
import { sameScope, validateHistoryQuery, validateHistoryScope } from '../../electron/historySchema'
import type { ReportQuery } from '../history/usageMetrics'
import { taskMetrics } from './taskMetrics'

export interface TaskAdvice {
  id: string
  kind: 'retry'|'context'|'output'|'outlier'|'model'|'timing'|'data'
  title: string
  evidence: string
  action: string
  limitation: string
  taskIds: string[]
}
const tokens=(t:TaskRecord)=>t.calls.reduce((sum,c)=>sum+(c.usage?c.usage.inputTokens+c.usage.outputTokens:0),0)
const complete=(t:TaskRecord)=>t.calls.length>0&&t.calls.every(c=>c.usage!==null)
const modelKey=(t:TaskRecord)=>JSON.stringify([...new Set(t.calls.map(c=>JSON.stringify([c.provider,c.model])))].sort())
const median=(v:number[])=>{const sorted=[...v].sort((a,b)=>a-b),i=Math.floor(sorted.length/2);return sorted.length%2?sorted[i]:(sorted[i-1]+sorted[i])/2}

/** Deterministic, scoped report advice. Never invokes a model or changes a task's execution settings. */
export function taskAdvice(input:TaskRecord[],query:ReportQuery):TaskAdvice[]{
  validateHistoryQuery(query)
  const report=taskMetrics(input,query),tasks=[...report.tasks].sort((a,b)=>a.endedAt.localeCompare(b.endedAt)||a.id.localeCompare(b.id)),advice:TaskAdvice[]=[]
  if(!tasks.length)return [{id:'no-tasks',kind:'data',title:'等待任务执行记录',evidence:'本区间没有已结束任务。',action:'执行器写入记录后，这里的建议会自动更新；也可导入对应账号的执行记录。',limitation:'分析阶段的 Token 估计不作为实际消耗。',taskIds:[]}]
  const baselines=new Map<string,TaskRecord[]>()
  const baselineKey=(t:TaskRecord)=>JSON.stringify([t.category,modelKey(t)])
  for(const t of tasks){if(t.status==='succeeded'&&complete(t)){const key=baselineKey(t);baselines.set(key,[...(baselines.get(key)??[]),t])}}
  for(const t of tasks){
    const wasted=t.calls.filter(c=>c.status==='failed'||c.attempt>1)
    if(wasted.length){
      const known=wasted.filter(c=>c.usage),amount=known.reduce((s,c)=>s+c.usage!.inputTokens+c.usage!.outputTokens,0)
      advice.push({id:`retry:${t.id}`,kind:'retry',title:`${t.label}：先排查失败与重试`,evidence:`${t.calls.length} 次调用中，${wasted.length} 次属于失败或重试尝试（不重复计数）；其中 ${known.length} 次提供用量，合计 ${amount} Token。`,action:'先查看对应调用的服务状态与任务结果；确认可重试后，设置重试上限，避免原样反复提交。',limitation:'失败或重试不一定浪费；未上报的用量未知，也不能从记录直接确定失败原因。',taskIds:[t.id]})
    }
    if(complete(t)){
      const total=tokens(t),ins=t.calls.reduce((s,c)=>s+c.usage!.inputTokens,0),outs=total-ins
      if(ins>=1000&&ins/total>=.8)advice.push({id:`context:${t.id}`,kind:'context',title:`${t.label}：检查重复上下文`,evidence:`全部 ${t.calls.length} 次调用都有用量；输入 ${ins} / 总计 ${total} Token，占比 ${(100*ins/total).toFixed(0)}%。`,action:'下次同类任务可检查是否反复附带相同资料；优先去除无关内容，保留必要上下文，再观察质量。',limitation:'输入占比高不等于内容冗余；缓存输入已包含在输入总量中，不能据此承诺费用下降。',taskIds:[t.id]})
      if(outs>=2000&&outs/total>=.7)advice.push({id:`output:${t.id}`,kind:'output',title:`${t.label}：明确需要的输出范围`,evidence:`全部调用输出 ${outs} / 总计 ${total} Token，占比 ${(100*outs/total).toFixed(0)}%。`,action:'如果结果过长，可在下次任务中约定篇幅或先生成提纲，确认后再展开。',limitation:'长输出可能是任务本身需要；不要为了省用量删减必要结果。',taskIds:[t.id]})
    }
    const rows=baselines.get(baselineKey(t))??[]
    let low=0,high=rows.length
    while(low<high){const mid=Math.floor((low+high)/2);if(rows[mid].endedAt<t.startedAt)low=mid+1;else high=mid}
    const prior=rows.slice(Math.max(0,low-20),low)
    if(t.status==='succeeded'&&complete(t)&&prior.length>=3){
      const baseline=median(prior.map(tokens)),duration=Date.parse(t.endedAt)-Date.parse(t.startedAt),durationBase=median(prior.map(p=>Date.parse(p.endedAt)-Date.parse(p.startedAt)))
      const highTokens=baseline>0&&tokens(t)>=2*baseline,slow=durationBase>0&&duration>=2*durationBase
      if(highTokens||slow)advice.push({id:`outlier:${t.id}`,kind:'outlier',title:`${t.label}：复盘这次明显增加的消耗`,evidence:`对比此前 ${prior.length} 个同类、同模型组合的成功任务：本次 ${tokens(t)} Token / 基准中位数 ${baseline}；耗时 ${(duration/60000).toFixed(1)} 分钟 / 基准 ${(durationBase/60000).toFixed(1)} 分钟。`,action:'检查任务是否更大、是否重复传入资料或发生等待；若内容可独立处理，可考虑分批并记录下次结果。',limitation:'同类任务也可能规模不同。这里只标记变化，不认定异常原因或保证拆分更省。',taskIds:[t.id,...prior.map(p=>p.id)]})
    }
  }
  const groups=new Map<string,TaskRecord[]>()
  for(const t of tasks){if(!t.evaluation||!t.calls.length||new Set(t.calls.map(c=>JSON.stringify([c.provider,c.model]))).size!==1)continue
    const e=t.evaluation,key=JSON.stringify([t.category,e.comparisonKey,e.method,e.rubricVersion]);groups.set(key,[...(groups.get(key)??[]),t])}
  let modelAdvice=0
  for(const [key,group] of groups){
    const byModel=new Map<string,TaskRecord[]>()
    for(const t of group){const model=modelKey(t);byModel.set(model,[...(byModel.get(model)??[]),t])}
    const options=[...byModel].flatMap(([model,rows])=>{
      // Include every evaluated task for that model in this comparison group; no cherry-picking successful runs.
      if(rows.length<3||rows.some(t=>t.status!=='succeeded'||!t.evaluation!.accepted||t.calls.some(c=>!c.cost||c.cost.basis!=='provider-reported')))return []
      const currencies=new Set(rows.flatMap(t=>t.calls.map(c=>c.cost!.currency)));if(currencies.size!==1)return []
      return [{model,rows,currency:[...currencies][0],cost:median(rows.map(t=>t.calls.reduce((s,c)=>s+c.cost!.amount,0))),duration:median(rows.map(t=>Date.parse(t.endedAt)-Date.parse(t.startedAt)))}]
    }).sort((a,b)=>a.cost-b.cost||a.model.localeCompare(b.model))
    for(const expensive of options){const cheaper=options.find(c=>c.model!==expensive.model&&c.currency===expensive.currency&&expensive.cost>0&&c.cost<=.8*expensive.cost&&c.duration<=1.25*expensive.duration);if(!cheaper)continue
      const from=expensive.rows[0].calls[0],to=cheaper.rows[0].calls[0]
      advice.push({id:`model:${key}:${expensive.model}`,kind:'model',title:`${group[0].category}：可试用 ${to.provider}/${to.model}`,evidence:`同一可比任务组和评价标准内，${from.model} / ${to.model} 分别有 ${expensive.rows.length} / ${cheaper.rows.length} 个已评价任务，均成功且达标。费用中位数 ${expensive.cost} / ${cheaper.cost} ${cheaper.currency}，候选耗时中位数不超过原模型的 1.25 倍。`,action:`下次相似任务可小范围试用 ${to.provider}/${to.model}，先确认访问权限、当前价格和可用额度，再决定是否调整优先级。`,limitation:'仅为所选区间内已评价任务的观察，不是随机对照实验；未评价任务不在比较中，也不保证未来质量或节省比例。不会自动切换模型。',taskIds:[...expensive.rows,...cheaper.rows].map(t=>t.id)});modelAdvice++
    }
  }
  if(report.reportedCalls<report.calls)advice.push({id:'missing-usage',kind:'data',title:'补全实际用量再判断节省空间',evidence:`${report.calls-report.reportedCalls}/${report.calls} 次调用未提供实际 Token。`,action:'让执行器记录服务商返回的 usage；重试和失败调用也尽量保留计量。',limitation:'缺失不按零计算，不用分析估计补账单。',taskIds:tasks.filter(t=>!complete(t)).map(t=>t.id)})
  if(!modelAdvice)advice.push({id:'model-evidence',kind:'data',title:'暂不推荐更换模型',evidence:'尚无满足质量、同类可比任务、同币种实报费用与样本量条件的明显更省候选。',action:'记录可比任务组和同一标准的达标评价；每个候选至少积累 3 个已评价任务，再比较费用与耗时。',limitation:'至少 20% 的费用差和 1.25 倍耗时上限是可调整规则，不是统计显著性。仅有模型名称或价格估计不会触发换模型建议。',taskIds:[]})
  if(tasks.some(t=>t.origin==='import'))advice.push({id:'imported-evidence',kind:'data',title:'建议包含用户导入的记录',evidence:'本区间部分任务来自手动导入。',action:'在据此改变任务安排前，核对来源和费用、质量评价是否可信。',limitation:'本地校验只检查格式与关联，未向服务商验证真实性。',taskIds:tasks.filter(t=>t.origin==='import').map(t=>t.id)})
  return advice.sort((a,b)=>({retry:0,outlier:1,context:2,output:2,model:3,timing:0,data:4}[a.kind]-{retry:0,outlier:1,context:2,output:2,model:3,timing:0,data:4}[b.kind])||a.id.localeCompare(b.id))
}

export interface PendingTaskContext {
  source: TaskRecord['source']; scopeId:string
  deadlineAt:string; urgent:boolean; estimatedDurationMs:number
  shortPoints:number; weeklyPoints:number
}
export interface CurrentQuota {
  source:TaskRecord['source'];scopeId:string;sampledAt:string;fresh:boolean
  shortRemaining:number;weeklyRemaining:number;shortResetAt:string;weeklyResetAt:string
}
/** Recheck-only scheduling advice: a reset timestamp never guarantees replenishment or capacity. */
export function timingAdvice(task:PendingTaskContext,quota:CurrentQuota|null,now=Date.now()):TaskAdvice {
  const base={id:'pending-timing',kind:'timing' as const,taskIds:[],limitation:'预算和耗时为输入估计；建议不会创建队列、启动任务或保证额度恢复。'}
  try{validateHistoryScope(task)}catch{return {...base,title:'任务账号信息无效',evidence:'无法确认任务属于当前账号。',action:'重新读取当前账号后再计算。'}}
  const deadline=Date.parse(task.deadlineAt)
  if(!Number.isFinite(now)||!Number.isFinite(deadline)||!Number.isFinite(task.estimatedDurationMs)||task.estimatedDurationMs<=0||task.estimatedDurationMs>366*86400000||![task.shortPoints,task.weeklyPoints].every(v=>Number.isFinite(v)&&v>=0&&v<=100)||typeof task.urgent!=='boolean')return {...base,title:'请补全有效任务预算',evidence:'需要截止时间、预计耗时以及两种窗口的预计额度（0–100 个百分点）。',action:'预算未知时不要填零；先由任务分析或历史同类任务提供估计。'}
  const buffer=Math.max(600000,task.estimatedDurationMs*.2)
  if(deadline<now+task.estimatedDurationMs+buffer)return {...base,title:'截止时间较紧，不建议等待恢复',evidence:'现有剩余时间不足以同时容纳预计耗时和安全余量（至少 10 分钟 / 预计耗时的 20%）。',action:'先缩小任务范围或调整截止时间，人工确认其他可用资源。'}
  if(!quota||!sameScope(task,quota)||!quota.fresh||!Number.isFinite(Date.parse(quota.sampledAt))||now-Date.parse(quota.sampledAt)>300000||Date.parse(quota.sampledAt)>now||![quota.shortRemaining,quota.weeklyRemaining].every(v=>Number.isFinite(v)&&v>=0&&v<=100))return {...base,title:'先刷新当前账号额度',evidence:'当前额度缺失、已超过 5 分钟、读取失败或账号不匹配。',action:'成功获取当前账号的新额度后，重新评估是否等待。'}
  const resets:number[]=[]
  if(task.shortPoints>quota.shortRemaining)resets.push(Date.parse(quota.shortResetAt))
  if(task.weeklyPoints>quota.weeklyRemaining)resets.push(Date.parse(quota.weeklyResetAt))
  if(!resets.length)return {...base,title:'当前额度覆盖填写的预算',evidence:`短周期 ${quota.shortRemaining} ≥ ${task.shortPoints}，周额度 ${quota.weeklyRemaining} ≥ ${task.weeklyPoints} 个百分点。`,action:'可按原计划人工确认执行，并保留余量观察实际消耗；无需仅为等待刷新而延期。'}
  if(task.urgent)return {...base,title:'紧急任务不建议自动延后',evidence:'填写的预算超过当前至少一个额度窗口，且任务标为紧急。',action:'优先人工确认可用资源、缩小范围或调整截止时间。'}
  if(resets.some(t=>!Number.isFinite(t)||t<=now))return {...base,title:'恢复时间需要重新确认',evidence:'不足的额度窗口存在未知或已过去的恢复时间。',action:'刷新额度；不能依据旧时间安排等待。'}
  const recheckAt=Math.max(...resets)
  if(recheckAt+task.estimatedDurationMs+buffer>deadline)return {...base,title:'等待恢复可能赶不上截止时间',evidence:'同时考虑不足的额度窗口、预计耗时和安全余量后，超过截止时间。',action:'先人工调整任务范围、截止时间或使用已确认可用的资源。'}
  return {...base,title:'可考虑等待恢复后再检查额度',evidence:`当前预算超过可用额度；不足窗口最晚恢复时间为 ${new Date(recheckAt).toISOString()}，之后仍留有预计耗时和安全余量。`,action:'如果任务可以等待，可在上述时间之后重新读取额度，确认两种窗口都满足预算，再由你决定执行。'}
}
