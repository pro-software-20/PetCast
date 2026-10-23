import type { TaskRecord } from '../../electron/taskLedgerSchema'
export interface TaskRequirements {images:boolean;tools:boolean;contextTokens:number|null}
export interface ModelCapabilities {images:boolean;tools:boolean;contextTokens:number|null}
export interface ModelPrice {
  currency:string;version:string;sourceUrl:string;validFrom:string;validUntil:string
  inputPerMillion:number;cachedInputPerMillion:number;outputPerMillion:number
  standardTokenBilling:boolean
}
export interface PlanCost {currency:string;amount:number;basis:'historical-reported'|'current-price-estimate';priceVersion?:string;priceSource?:string}
const positive=(n:unknown):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>0
export function capabilityProblem(required:TaskRequirements|undefined,cap:ModelCapabilities|undefined):string|null {
  if(!required)return null
  if(typeof required.images!=='boolean'||typeof required.tools!=='boolean'||(required.contextTokens!==null&&!positive(required.contextTokens)))return '任务能力要求无效，请填写正确的上下文 Token 数。'
  if(required.images&&cap?.images!==true)return '任务需要图片能力，尚未确认模型支持。'
  if(required.tools&&cap?.tools!==true)return '任务需要工具调用，尚未确认模型支持。'
  if(required.contextTokens!==null&&(!positive(cap?.contextTokens)||cap!.contextTokens!<required.contextTokens))return '模型上下文容量未知或不足以覆盖本次任务。'
  return null
}
export function estimateByPrice(rows:TaskRecord[],price:ModelPrice,now:number):{cost?:PlanCost;error?:string}{
  const numbers=[price.inputPerMillion,price.cachedInputPerMillion,price.outputPerMillion]
  let url:URL;try{url=new URL(price.sourceUrl)}catch{return {error:'价格来源需要有效的公开网页地址。'}}
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password||price.sourceUrl.length>1000)return {error:'价格来源地址无效，请勿填写凭据。'}
  if(!/^[A-Z]{3}$/.test(price.currency)||typeof price.version!=='string'||!price.version.trim()||price.version.length>100||numbers.some(n=>typeof n!=='number'||!Number.isFinite(n)||n<0||n>1e9)||price.standardTokenBilling!==true)return {error:'价格配置不完整，需确认单价覆盖任务全部 Token 计费。'}
  const from=Date.parse(price.validFrom),until=Date.parse(price.validUntil)
  if(!Number.isFinite(from)||!Number.isFinite(until)||from>now||until<=now||until<=from)return {error:'价格尚未生效或已过期，请更新价格依据。'}
  const totals:number[]=[]
  for(const t of rows){let total=0;for(const c of t.calls){const u=c.usage;if(!u)return {error:'费用估算需要每次调用的实际输入输出 Token。'}
    if(u.cachedInputTokens===null&&price.cachedInputPerMillion!==price.inputPerMillion)return {error:'缓存 Token 未知且缓存单价不同，无法可靠估算。'}
    const cached=u.cachedInputTokens??0
    total+=((u.inputTokens-cached)*price.inputPerMillion+cached*price.cachedInputPerMillion+u.outputTokens*price.outputPerMillion)/1e6
  }totals.push(total)}
  if(!totals.length)return {error:'没有可用于估算的任务。'}
  totals.sort((a,b)=>a-b)
  return {cost:{currency:price.currency,amount:totals[Math.ceil(totals.length*.8)-1],basis:'current-price-estimate',priceVersion:price.version,priceSource:price.sourceUrl}}
}
