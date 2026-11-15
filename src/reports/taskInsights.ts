import type { TaskRecord } from '../history/TaskLedger'

export interface TaskInsight {
  id: string
  title: string
  evidence: string
  action: string
  taskIds: string[]
}

/** Input is the account/period-filtered, validated task ledger. */
export function taskInsights(tasks: TaskRecord[]): TaskInsight[] {
  const insights: TaskInsight[] = []
  const failed = tasks.filter(t => t.status === 'failed')
  if (failed.length) insights.push({
    id: 'failed', title: '先处理未完成任务',
    evidence: `${tasks.length} 项任务中，${failed.length} 项执行失败。`,
    action: '打开失败任务查看错误与交接记录，修正原因后再重试。',
    taskIds: failed.map(t => t.id),
  })
  const retried = tasks.filter(t => t.calls.some(c => c.attempt > 1))
  const retries = retried.flatMap(t => t.calls.filter(c => c.attempt > 1))
  const measured = retries.filter(c => c.usage !== null)
  if (retries.length) insights.push({
    id: 'retry', title: '检查重复执行的步骤',
    evidence: `${retried.length} 项任务发生 ${retries.length} 次重试调用` +
      (measured.length ? `，其中 ${measured.length} 次上报 ${measured.reduce((sum,c) => sum + c.usage!.inputTokens + c.usage!.outputTokens, 0).toLocaleString()} Token。` : '。'),
    action: '对照重试原因，保留已验收的步骤和交接摘要，避免整项重跑。',
    taskIds: retried.map(t => t.id),
  })
  const missing = tasks.filter(t => t.calls.some(c => c.usage === null))
  const calls = tasks.flatMap(t => t.calls)
  if (missing.length) insights.push({
    id: 'metering', title: '补齐用量记录',
    evidence: `${calls.length} 次调用中，${calls.filter(c => c.usage === null).length} 次未返回 Token。`,
    action: '检查对应平台的用量回传设置，再比较模型消耗。',
    taskIds: missing.map(t => t.id),
  })
  return insights
}
