import { loadPlannerSettings, savePlannerSettings } from '../reports/plannerSettings'
import { useEffect, useMemo, useState } from 'react'
import type { TaskRecord } from '../../electron/taskLedgerSchema'
import type { ReportQuery } from '../history/usageMetrics'
import type { CurrentQuota } from '../reports/taskAdvisor'
import { recommendTaskPlan, type ModelCapacity, type PendingPlanTask, type ModelPlan } from '../reports/unifiedPlanner'

type CandidateSetting={kind:'money'|'quota';budget:string;currency:string;short:string;weekly:string;preference:number;checkedAt:string|null;images:boolean;tools:boolean;context:string;priceEnabled:boolean;priceSource:string;priceVersion:string;priceFrom:string;priceUntil:string;inputPrice:string;cachedPrice:string;outputPrice:string;standardBilling:boolean}
const defaults=(demo:boolean,openedAt:number):CandidateSetting=>({kind:'money',budget:demo?'10':'',currency:'USD',short:'',weekly:'',preference:10,checkedAt:demo?new Date(openedAt).toISOString():null,images:false,tools:false,context:demo?'8192':'',priceEnabled:false,priceSource:'',priceVersion:'',priceFrom:'',priceUntil:'',inputPrice:'',cachedPrice:'',outputPrice:'',standardBilling:false})
const localInput=(time:number)=>{const d=new Date(time);return new Date(time-d.getTimezoneOffset()*60000).toISOString().slice(0,16)}
const dateText=(value:string|null)=>value?new Date(value).toLocaleString('zh-CN'):'—'
const groupKey=(t:TaskRecord)=>JSON.stringify([t.category,t.evaluation!.comparisonKey,t.evaluation!.method,t.evaluation!.rubricVersion])
export function UnifiedPlanPanel({tasks,scope,quota,demo=false}:{tasks:TaskRecord[];scope:ReportQuery;quota:CurrentQuota|null;demo?:boolean}){
  const [openedAt]=useState(()=>Date.now())
  const records=useMemo(()=>demo?makePlanDemo(scope,openedAt):tasks,[tasks,demo,scope,openedAt])
  const groups=useMemo(()=>[...new Map(records.filter(t=>t.evaluation).map(t=>[groupKey(t),t])).entries()],[records])
  const [selected,setSelected]=useState(''),[deadline,setDeadline]=useState(()=>demo?localInput(openedAt+8*3600000):'')
  const [priority,setPriority]=useState<PendingPlanTask['priority']>('normal'),[allowWait,setAllowWait]=useState(true)
  const [qualityPolicy,setQualityPolicy]=useState<'strict'|'recent'>('strict')
  const [taskBudget,setTaskBudget]=useState(''),[taskCurrency,setTaskCurrency]=useState('USD')
  const [needsImages,setNeedsImages]=useState(false),[needsTools,setNeedsTools]=useState(false),[context,setContext]=useState(demo?'2000':''),[allowEstimated,setAllowEstimated]=useState(false),[locked,setLocked]=useState('')
  const [settingsError,setSettingsError]=useState('')
  const [settings,setSettings]=useState<Record<string,CandidateSetting>>(()=>{if(demo)return {};try{return Object.fromEntries(Object.entries(loadPlannerSettings(localStorage,scope)).map(([key,value])=>[key,{...defaults(false,openedAt),...value}]))}catch{return {}}})
  const [settingsChanged,setSettingsChanged]=useState(false)
  useEffect(()=>{if(demo)return;try{loadPlannerSettings(localStorage,scope)}catch{setSettingsError('保存的模型设置无法读取；原设置保留，请重新填写后保存。')}},[])
  useEffect(()=>{if(demo||!settingsChanged)return;try{savePlannerSettings(localStorage,scope,settings);setSettingsError('')}catch{setSettingsError('模型设置未保存；本次仍可使用，请检查输入或存储空间。')}},[settings,settingsChanged,demo,scope.source,scope.scopeId])
  const activeKey=selected||groups[0]?.[0]||'',group=groups.find(([key])=>key===activeKey)?.[1]
  const models=useMemo(()=>[...new Map(records.filter(t=>t.evaluation&&groupKey(t)===activeKey).flatMap(t=>t.calls).map(c=>[JSON.stringify([c.provider,c.model]),{provider:c.provider,model:c.model}])).entries()],[records,activeKey])
  const setting=(key:string):CandidateSetting=>settings[key]??defaults(demo,openedAt)
  const update=(key:string,patch:Partial<CandidateSetting>)=>{setSettingsChanged(true);setSettings(old=>({...old,[key]:{...setting(key),...patch,checkedAt:null}}))}
  const capacities:ModelCapacity[]=models.map(([key,name])=>{
    const s=setting(key),useQuota=s.kind==='quota'
    const live=quota&&Number.isFinite(Date.parse(quota.sampledAt))&&quota.fresh&&quota.source===scope.source&&quota.scopeId===scope.scopeId?quota:null
    return {...scope,...name,enabled:!!s.checkedAt,preference:s.preference,checkedAt:useQuota&&live&&s.checkedAt?new Date(Math.min(Date.parse(s.checkedAt??''),Date.parse(live.sampledAt))).toISOString():s.checkedAt??'',basis:'user-confirmed',capabilities:{images:s.images,tools:s.tools,contextTokens:s.context.trim()?Number(s.context):null},price:s.priceEnabled?{currency:s.currency,sourceUrl:s.priceSource,version:s.priceVersion,validFrom:Number.isFinite(Date.parse(s.priceFrom))?new Date(s.priceFrom).toISOString():'',validUntil:Number.isFinite(Date.parse(s.priceUntil))?new Date(s.priceUntil).toISOString():'',inputPerMillion:s.inputPrice.trim()?Number(s.inputPrice):NaN,cachedInputPerMillion:s.cachedPrice.trim()?Number(s.cachedPrice):NaN,outputPerMillion:s.outputPrice.trim()?Number(s.outputPrice):NaN,standardTokenBilling:s.standardBilling}:undefined,capacity:useQuota?{kind:'quota',windows:[{key:'short',remaining:live?.shortRemaining??NaN,needed:s.short.trim()?Number(s.short):NaN,resetAt:live?.shortResetAt??''},{key:'weekly',remaining:live?.weeklyRemaining??NaN,needed:s.weekly.trim()?Number(s.weekly):NaN,resetAt:live?.weeklyResetAt??''}]}:{kind:'money',currency:s.currency,remaining:s.budget.trim()?Number(s.budget):NaN}}
  })
  const result=group&&deadline?recommendTaskPlan({...scope,category:group.category,comparisonKey:group.evaluation!.comparisonKey,method:group.evaluation!.method,rubricVersion:group.evaluation!.rubricVersion,deadlineAt:Number.isFinite(Date.parse(deadline))?new Date(deadline).toISOString():deadline,priority,allowWait,qualityPolicy,requirements:{images:needsImages,tools:needsTools,contextTokens:context.trim()?Number(context):null},allowEstimatedCost:allowEstimated,lockedModel:locked?{provider:JSON.parse(locked)[0],model:JSON.parse(locked)[1]}:undefined,budget:taskBudget.trim()?{amount:Number(taskBudget),currency:taskCurrency}:null},records,capacities):null
  const card=(p:ModelPlan,recommended=false)=><article className="task-advice-card" key={JSON.stringify([p.provider,p.model])} data-plan-state={p.state}>
    <h4>{recommended?'推荐候选：':''}{p.provider} / {p.model} · {{ready:'当前条件下可考虑执行',recheck:'等待后重查额度的条件方案',blocked:'本次排除',missing:'待补信息'}[p.state]}</h4>
    {p.startAt&&<p><b>{p.state==='recheck'?'建议重新检查时间':'建议开始时间'}：</b>{dateText(p.startAt)}<br/><b>预计完成（含余量）：</b>{dateText(p.finishAt)}<br/><b>最晚开始参考：</b>{dateText(p.latestStartAt)}</p>}
    <p>历史样本 {p.sampleCount} 个 · Token 参考 {p.tokenEstimate??'未知'} · 费用参考 {p.cost?`${p.cost.amount} ${p.cost.currency}（${p.cost.basis==='current-price-estimate'?'当前单价估算':'历史实报'}）`:'未知'}</p>{p.cost?.priceSource&&<p>价格版本：{p.cost.priceVersion} · 来源：{p.cost.priceSource}</p>}
    <ul>{p.reasons.map((r,i)=><li key={i}>{r}</li>)}</ul>
    {p.limitations.length>0&&<details><summary>依据的适用范围</summary><ul>{p.limitations.map((r,i)=><li key={i}>{r}</li>)}</ul></details>}
    {p.taskIds.length>0&&<details><summary>关联历史任务（{p.taskIds.length}）</summary><p>{p.taskIds.join('、')}</p></details>}
  </article>
  return <details className="unified-plan" open={demo}><summary>为一个待办任务综合推荐模型与时间</summary>
    <p>{demo?'独立模拟示意：使用 6 条构造任务和模拟预算，不保存到真实账本。':'从独立的近期历史中选择与待办任务相同的可比任务组；确认任务规模和验收要求相近后再使用。'} 时间按本机时区显示。</p>
    {!demo&&<p>模型能力、偏好及价格配置按账号保存在本机；余额与访问确认不保存，每次打开需重新确认。</p>}{settingsError&&<p role="alert">{settingsError}</p>}
    <details open={!groups.length}><summary>新用户 / 证据不足时怎么选</summary><ol><li>先在执行模块手动选择自己可访问、满足能力要求的模型，设置小额预算和明确验收标准。</li><li>用少量规模相近的真实任务试用，完成后记录结果评价；当前页面不会代为调用或自动试跑。</li><li>积累至少 3 个同组、同标准的已评价任务后再查看推荐。有失败时先检查原因，不删除差评来凑门槛。</li></ol><p>人工选择不代表系统已证明其质量或省钱；样本不足时不会生成确定的费用和完成时间承诺。</p></details>
    {!groups.length&&<p>尚无带质量评价的可比任务组。请在完成任务后记录质量评价，或导入本账号带评价的真实记录；不能仅凭模型名称与额度推荐。</p>}
    <div className="history-filters">
      <label>质量策略<select aria-label="推荐质量策略" value={qualityPolicy} onChange={e=>setQualityPolicy(e.target.value as 'strict'|'recent')}><option value="strict">保守：至少 3 次且已评价样本全部达标</option><option value="recent">近期：最近 10 次中至少 5 次，达标率 ≥80% 且最近一次达标</option></select></label>
      <label>任务组<select aria-label="综合推荐任务组" value={activeKey} onChange={e=>{setSelected(e.target.value);setSettings(old=>Object.fromEntries(Object.entries(old).map(([k,v])=>[k,{...v,checkedAt:null,budget:'',short:'',weekly:''}])));setLocked('')}}><option value="" disabled>选择已有可比任务组</option>{groups.map(([key,t])=><option key={key} value={key}>{t.category} · {t.evaluation!.comparisonKey} · {t.evaluation!.rubricVersion}</option>)}</select></label>
      <label>指定模型<select aria-label="综合推荐指定模型" value={locked} onChange={e=>setLocked(e.target.value)}><option value="">自动比较</option>{locked&&!models.some(([k])=>k===locked)&&<option value={locked}>已指定模型当前无可用样本</option>}{models.map(([k,m])=><option value={k} key={k}>{m.provider} / {m.model}</option>)}</select></label>
      <label><input type="checkbox" aria-label="任务需要图片" checked={needsImages} onChange={e=>setNeedsImages(e.target.checked)}/>需要图片理解</label>
      <label><input type="checkbox" aria-label="任务需要工具" checked={needsTools} onChange={e=>setNeedsTools(e.target.checked)}/>需要工具调用</label>
      <label>预计完整上下文 Token<input aria-label="任务上下文需求" type="number" min="1" step="1" value={context} onChange={e=>setContext(e.target.value)}/></label>
      <label><input type="checkbox" aria-label="允许价格估算" checked={allowEstimated} onChange={e=>setAllowEstimated(e.target.checked)}/>允许使用有来源的当前单价估算（非实付）</label>
      <label>截止时间<input aria-label="综合推荐截止时间" type="datetime-local" value={deadline} onChange={e=>setDeadline(e.target.value)}/></label>
      <label>任务优先级<select aria-label="综合推荐优先级" value={priority} onChange={e=>setPriority(e.target.value as PendingPlanTask['priority'])}><option value="urgent">紧急</option><option value="high">高</option><option value="normal">普通</option><option value="low">低</option></select></label>
      <label><input type="checkbox" aria-label="综合推荐允许等待" checked={allowWait} onChange={e=>setAllowWait(e.target.checked)}/>允许等待额度恢复（紧急任务除外）</label>
      <label>本次费用上限（选填）<input aria-label="综合推荐费用上限" type="number" min="0" step="any" value={taskBudget} onChange={e=>setTaskBudget(e.target.value)}/></label><label>币种<select aria-label="综合推荐费用币种" value={taskCurrency} onChange={e=>setTaskCurrency(e.target.value)}><option>USD</option><option>CNY</option></select></label>
    </div>
    {models.map(([key,name])=>{const s=setting(key);return <fieldset className="plan-capacity" key={key}><legend>{name.provider} / {name.model}</legend><div className="history-filters">
      <label>资源依据<select aria-label={`资源依据 ${name.model}`} value={s.kind} onChange={e=>update(key,{kind:e.target.value as CandidateSetting['kind']})}><option value="money">我确认的可用费用预算</option>{name.provider.toLowerCase()==='codex'&&<option value="quota">当前 Codex 两种额度窗口</option>}</select></label>
      {s.kind==='money'?<><label>可用预算<input aria-label={`可用预算 ${name.model}`} type="number" min="0" step="any" value={s.budget} onChange={e=>update(key,{budget:e.target.value})}/></label><select aria-label={`预算币种 ${name.model}`} value={s.currency} onChange={e=>update(key,{currency:e.target.value})}><option>USD</option><option>CNY</option></select></>:<><label>预计短周期百分点<input aria-label={`短周期预算 ${name.model}`} type="number" min="0" max="100" step="any" value={s.short} onChange={e=>update(key,{short:e.target.value})}/></label><label>预计周百分点<input aria-label={`周预算 ${name.model}`} type="number" min="0" max="100" step="any" value={s.weekly} onChange={e=>update(key,{weekly:e.target.value})}/></label><p>读取当前账号额度；预算未知留空，不能按零处理。此选项只供执行器记录为 codex 的模型使用。</p></>}
      <label><input type="checkbox" aria-label={`模型支持图片 ${name.model}`} checked={s.images} onChange={e=>update(key,{images:e.target.checked})}/>支持图片理解</label>
      <label><input type="checkbox" aria-label={`模型支持工具 ${name.model}`} checked={s.tools} onChange={e=>update(key,{tools:e.target.checked})}/>支持工具调用</label>
      <label>上下文容量 Token<input aria-label={`模型上下文 ${name.model}`} type="number" min="1" step="1" value={s.context} onChange={e=>update(key,{context:e.target.value})}/></label>
      <label>模型偏好顺序<input aria-label={`模型顺序 ${name.model}`} type="number" min="0" max="999" value={s.preference} onChange={e=>update(key,{preference:Number(e.target.value)})}/></label>
      <details className="plan-price"><summary>当前单价与依据（可选）</summary><p>单价单位：{s.currency} / 百万 Token。只支持已确认完整的 Token 计费；不自动抓取价格，不支持图片额外计费。</p><div className="history-filters">
        <label><input type="checkbox" aria-label={`启用单价 ${name.model}`} checked={s.priceEnabled} onChange={e=>update(key,{priceEnabled:e.target.checked})}/>为此模型配置单价</label>
        <label>价格来源网页<input aria-label={`价格来源 ${name.model}`} type="url" value={s.priceSource} onChange={e=>update(key,{priceSource:e.target.value})}/></label>
        <label>价格版本<input aria-label={`价格版本 ${name.model}`} maxLength={100} value={s.priceVersion} onChange={e=>update(key,{priceVersion:e.target.value})}/></label>
        <label>生效时间<input aria-label={`价格生效 ${name.model}`} type="datetime-local" value={s.priceFrom} onChange={e=>update(key,{priceFrom:e.target.value})}/></label>
        <label>有效至<input aria-label={`价格到期 ${name.model}`} type="datetime-local" value={s.priceUntil} onChange={e=>update(key,{priceUntil:e.target.value})}/></label>
        <label>非缓存输入<input aria-label={`输入单价 ${name.model}`} type="number" min="0" step="any" value={s.inputPrice} onChange={e=>update(key,{inputPrice:e.target.value})}/></label>
        <label>缓存输入<input aria-label={`缓存单价 ${name.model}`} type="number" min="0" step="any" value={s.cachedPrice} onChange={e=>update(key,{cachedPrice:e.target.value})}/></label>
        <label>输出（含推理）<input aria-label={`输出单价 ${name.model}`} type="number" min="0" step="any" value={s.outputPrice} onChange={e=>update(key,{outputPrice:e.target.value})}/></label>
        <label><input type="checkbox" aria-label={`确认计费口径 ${name.model}`} checked={s.standardBilling} onChange={e=>update(key,{standardBilling:e.target.checked})}/>我已确认这些单价覆盖本任务全部 Token 计费，无其他收费项目</label>
      </div></details>
      <button onClick={()=>setSettings(old=>({...old,[key]:{...s,checkedAt:new Date(Date.now()).toISOString()}}))}>确认 {name.model} 当前可访问及预算</button>
      <small>{s.checkedAt?`确认于 ${dateText(s.checkedAt)}，5 分钟内有效`:'尚未确认'}；偏好顺序数值越小越优先，用于其他指标相同的情况。</small>
    </div></fieldset>})}
    <section aria-label="综合推荐结果" data-unified-state={result?.state??'incomplete'}>
      {result?<><p><b>{result.explanation}</b></p>{result.recommendation&&card(result.recommendation,true)}{result.alternatives.length>0&&<details open><summary>其他候选与排除原因（{result.alternatives.length}）</summary>{result.alternatives.map(p=>card(p))}</details>}<ul>{result.warnings.map(w=><li key={w}>{w}</li>)}</ul></>:<p>选择可比任务组、填写截止时间并逐个确认候选模型的资源后，自动生成统一方案。</p>}
    </section>
  </details>
}
function makePlanDemo(scope:ReportQuery,now:number):TaskRecord[]{
  return Array.from({length:6},(_,i)=>{const cheap=i<3,id=`plan-demo-${i}`,startedAt=new Date(now-(i+1)*86400000).toISOString(),endedAt=new Date(Date.parse(startedAt)+(cheap?30:5)*60000).toISOString()
    return {...scope,id,label:'综合推荐示意',category:'资料整理',origin:'executor',status:'succeeded',startedAt,endedAt,quota:null,evaluation:{comparisonKey:'相同资料规模',method:'rubric',rubricVersion:'完整性-v1',accepted:true},calls:[{id:`plan-demo-call-${i}`,taskId:id,provider:'示意平台',model:cheap?'节约模型':'快速模型',startedAt,endedAt,status:'succeeded',attempt:1,usage:{inputTokens:1000,outputTokens:200,cachedInputTokens:null,basis:'provider-reported'},cost:{amount:cheap ? .01 : .05,currency:'USD',basis:'provider-reported'}}]}
  })
}
