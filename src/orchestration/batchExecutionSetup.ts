import type { TaskSessionV1 } from '../types/taskOrchestration'
import { canEditTaskExecutionMode, updateTaskSession } from './taskSession'
import { getHandoffReadiness } from './taskHandoff'

export function prepareDeepSeekBatch(session: TaskSessionV1, provider: 'deepseek' | 'codex' = 'deepseek') {
  let current = session
  const configured: string[] = []
  const skipped: Array<{ taskId: string; reason: string }> = []
  for (const task of session.plan.tasks) {
    const skip = (reason: string) => skipped.push({ taskId: task.id, reason })
    if (!canEditTaskExecutionMode(current, task.id)) { skip('任务已开始或不可修改'); continue }
    // The current API adapter returns text only. Never pretend it can read/write local files.
    if (task.files.inputs.length || task.files.readPaths?.length || task.files.allowedWritePaths.length || task.files.outputPaths.length
      || /运行测试|执行测试|修改.*文件|写入.*文件|浏览器操作|点击|上传|下载|联网检索/.test(`${task.title} ${task.description} ${task.prompt}`)) {
      skip('需要文件、工具或软件操作，保留原执行方式'); continue
    }
    const assigned = updateTaskSession(current, { type: 'assign-provider', taskId: task.id, providerId: provider })
    if (!assigned.ok) { skip(assigned.message); continue }
    if (!getHandoffReadiness(assigned.session, task.id, provider === 'codex' ? 'local-agent' : 'manual', provider).ready) { skip('前置资料尚未确认'); continue }
    const mode = updateTaskSession(assigned.session, { type: 'set-task-execution-mode', taskId: task.id, executionMode: provider === 'codex' ? 'local-agent' : 'api' })
    if (!mode.ok) { skip(mode.message); continue }
    current = mode.session
    configured.push(task.id)
  }
  return { session: current, configured, skipped }
}
