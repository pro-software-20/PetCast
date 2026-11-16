import type { TaskRecord } from '../history/TaskLedger'

export function taskTiming(task: TaskRecord) {
  const start = Date.parse(task.startedAt), end = Date.parse(task.endedAt)
  const intervals = task.calls.map(call => [Math.max(start, Date.parse(call.startedAt)), Math.min(end, Date.parse(call.endedAt))])
    .filter(([a,b]) => b >= a).sort((a,b) => a[0]-b[0])
  let last = start, active = 0
  for (const [a,b] of intervals) {
    active += Math.max(0, b-Math.max(last,a))
    last = Math.max(last,b)
  }
  return { elapsed: end-start, active: intervals.length ? active : null, gap: intervals.length ? end-start-active : null }
}

export function taskHabits(tasks: TaskRecord[]) {
  const models = new Map<string,number>(), categories = new Map<string,number>()
  const providers = new Map<string,{ provider:string; calls:number; measured:number; tokens:number }>()
  let retryCalls = 0, retryTokens = 0, measuredRetries = 0
  for (const task of tasks) {
    categories.set(task.category,(categories.get(task.category)??0)+1)
    for (const c of task.calls) {
      const model = c.provider+' / '+c.model
      models.set(model,(models.get(model)??0)+1)
      const row = providers.get(c.provider) ?? {provider:c.provider,calls:0,measured:0,tokens:0}
      row.calls++
      if (c.usage) { row.measured++; row.tokens+=c.usage.inputTokens+c.usage.outputTokens }
      providers.set(c.provider,row)
      if(c.attempt>1){ retryCalls++; if(c.usage){measuredRetries++;retryTokens+=c.usage.inputTokens+c.usage.outputTokens} }
    }
  }
  const rank = (map: Map<string,number>)=>Array.from(map).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))
  return {models:rank(models),categories:rank(categories),providers:[...providers.values()],retryCalls,retryTokens,measuredRetries}
}

