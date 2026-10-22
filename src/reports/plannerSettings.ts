import { validateHistoryScope, type HistoryScope } from '../../electron/historySchema'
export interface StableModelSetting {
  kind:'money'|'quota';currency:string;preference:number;images:boolean;tools:boolean;context:string
  priceEnabled:boolean;priceSource:string;priceVersion:string;priceFrom:string;priceUntil:string
  inputPrice:string;cachedPrice:string;outputPrice:string;standardBilling:boolean
}
const strings=['context','priceSource','priceVersion','priceFrom','priceUntil','inputPrice','cachedPrice','outputPrice'] as const
const booleans=['images','tools','priceEnabled','standardBilling'] as const
export function plannerSettingsKey(scope:HistoryScope){validateHistoryScope(scope);return 'petcast.planner-settings.v1:'+JSON.stringify([scope.source,scope.scopeId])}
/** Explicit allowlist: never restore balance, estimated quota use, or access confirmation. */
export function stableSettings(input:unknown):Record<string,StableModelSetting>{
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length>100)throw Error('模型设置格式无效')
  const output:Record<string,StableModelSetting>={}
  for(const [key,raw] of Object.entries(input)){
    const pair=JSON.parse(key);if(!Array.isArray(pair)||pair.length!==2||pair.some(s=>typeof s!=='string'||!s.trim()||s.length>100))throw Error('模型标识无效')
    const v=raw as StableModelSetting
    if(!v||!['money','quota'].includes(v.kind)||!['USD','CNY'].includes(v.currency)||!Number.isInteger(v.preference)||v.preference<0||v.preference>999)throw Error('模型设置无效')
    if(booleans.some(k=>typeof v[k]!=='boolean')||strings.some(k=>typeof v[k]!=='string'||v[k].length>(k==='priceSource'?1000:100)))throw Error('模型设置字段无效')
    output[key]={kind:v.kind,currency:v.currency,preference:v.preference,images:v.images,tools:v.tools,context:v.context,priceEnabled:v.priceEnabled,priceSource:v.priceSource,priceVersion:v.priceVersion,priceFrom:v.priceFrom,priceUntil:v.priceUntil,inputPrice:v.inputPrice,cachedPrice:v.cachedPrice,outputPrice:v.outputPrice,standardBilling:v.standardBilling}
  }
  return output
}
export function loadPlannerSettings(storage:Pick<Storage,'getItem'>,scope:HistoryScope){const raw=storage.getItem(plannerSettingsKey(scope));if(raw===null)return {};const doc=JSON.parse(raw);if(doc.version!==1)throw Error('模型设置版本无效');return stableSettings(doc.models)}
export function savePlannerSettings(storage:Pick<Storage,'setItem'>,scope:HistoryScope,models:unknown){storage.setItem(plannerSettingsKey(scope),JSON.stringify({version:1,models:stableSettings(models)}))}
