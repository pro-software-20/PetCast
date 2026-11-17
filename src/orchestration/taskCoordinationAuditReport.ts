import type { TaskCoordinationAuditEvent, TaskCoordinationAuditStateV1 } from '../types/taskCoordination'

export interface TaskCoordinationAuditExport {
  fileName: string
  markdown: string
  json: string
}

const eventLine = (event: TaskCoordinationAuditEvent) => {
  const refs = [event.taskId && `任务 ${event.taskId}`, event.providerId && `执行方 ${event.providerId}`,
    event.dispatchId && `派发 ${event.dispatchId.slice(-10)}`, event.attempt !== undefined && `尝试 ${event.attempt}`]
    .filter(Boolean).join('；')
  return `- ${event.occurredAt} · ${event.level} · ${event.type}${refs ? ` · ${refs}` : ''}：${event.summary}`
}

/** Export only the already-sanitised audit state. Never add task prompts or output. */
export const generateTaskCoordinationAuditExport = (
  state: TaskCoordinationAuditStateV1,
): TaskCoordinationAuditExport => {
  const payload = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    sessionId: state.sessionId,
    planId: state.planId,
    updatedAt: state.updatedAt,
    events: state.events,
  }
  return {
    fileName: `petcast-coordination-audit-${state.sessionId}.json`,
    json: JSON.stringify(payload, null, 2),
    markdown: [
      '# PetCast 协调审计记录',
      '',
      `- 会话：${state.sessionId}`,
      `- 计划：${state.planId}`,
      `- 导出时间：${payload.exportedAt}`,
      `- 事件数：${state.events.length}`,
      '',
      '## 时间线',
      '',
      ...(state.events.length ? state.events.map(eventLine) : ['- 暂无协调事件。']),
      '',
      '> 此导出仅包含脱敏协调事件，不含任务 Prompt、完整 AI 输出、凭据、绝对路径、额度或供应商原始响应。',
    ].join('\n'),
  }
}
