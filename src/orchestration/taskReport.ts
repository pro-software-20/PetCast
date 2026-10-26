import { validateTaskSession } from './taskSessionValidation'
import type { TaskSessionV1 } from '../types/taskOrchestration'

export type TaskReportOutcome =
  | { ok: true; markdown: string; fileName: string }
  | { ok: false; code: 'INVALID_SESSION' | 'SESSION_INCOMPLETE'; message: string }

const statusLabels = {
  passed: '通过',
  failed: '失败',
  'not-run': '未执行',
} as const

const safeFileName = (value: string) => {
  const normalized = value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/\s+/g, '-').slice(0, 60)
  return normalized || 'task-report'
}

export function generateTaskSessionReport(session: TaskSessionV1): TaskReportOutcome {
  if (!validateTaskSession(session).ok) {
    return { ok: false, code: 'INVALID_SESSION', message: '任务会话无效，无法生成报告。' }
  }
  if (!session.completedAt) {
    return { ok: false, code: 'SESSION_INCOMPLETE', message: '全部任务和最终验收通过后才能生成报告。' }
  }

  const sections = session.plan.tasks.map((task, index) => {
    const run = session.runs.find(candidate => candidate.taskId === task.id)
    const result = run?.result
    const changedFiles = result?.changedFiles.length
      ? result.changedFiles.map(path => `- ${path}`).join('\n')
      : '- 无记录'
    const checks = result?.verification.map(item => (
      `- [${item.status === 'passed' ? 'x' : ' '}] ${item.label}：${statusLabels[item.status]}${item.details ? `（${item.details}）` : ''}`
    )).join('\n') ?? '- 无记录'
    const handoff = result?.handoff
    const handoffDetails = handoff
      ? [
        handoff.summary,
        '',
        '#### 关键决策',
        '',
        ...(handoff.keyDecisions.length ? handoff.keyDecisions.map(item => `- ${item}`) : ['- 无']),
        '',
        '#### 交接文件',
        '',
        ...(handoff.artifacts.length
          ? handoff.artifacts.map(artifact => `- ${artifact.path}：${artifact.description}`)
          : ['- 无']),
        '',
        '#### 遗留问题',
        '',
        ...(handoff.openQuestions.length ? handoff.openQuestions.map(item => `- ${item}`) : ['- 无']),
      ].join('\n')
      : '旧任务未记录结构化交接信息。'

    return [
      `## ${index + 1}. ${task.title}`,
      '',
      `- 状态：${run?.status ?? '未知'}`,
      `- 执行 AI：${run?.assignedProviderId ?? task.recommendedProviderId}`,
      `- 尝试次数：${run?.attempt ?? 0}`,
      `- 开始时间：${run?.startedAt ?? '未记录'}`,
      `- 完成时间：${run?.completedAt ?? '未记录'}`,
      '',
      '### 结果摘要',
      '',
      result?.summary ?? '无结果摘要',
      '',
      '### 修改文件',
      '',
      changedFiles,
      '',
      '### 验收记录',
      '',
      checks,
      '',
      '### 人工备注',
      '',
      result?.reviewNote || '无',
      '',
      '### 后续任务交接',
      '',
      handoffDetails,
    ].join('\n')
  })

  const finalChecks = session.finalVerification.map(item => (
    `- [${item.status === 'passed' ? 'x' : ' '}] ${item.label}：${statusLabels[item.status]}${item.details ? `（${item.details}）` : ''}`
  )).join('\n')
  const assumptions = session.plan.assumptions.length
    ? session.plan.assumptions.map(item => `- ${item}`).join('\n')
    : '- 无'

  const markdown = [
    `# ${session.plan.title}：执行报告`,
    '',
    `- 会话 ID：${session.id}`,
    `- 创建时间：${session.createdAt}`,
    `- 完成时间：${session.completedAt}`,
    '- 执行方式：人工复制与人工验收',
    '',
    '## 总体目标',
    '',
    session.plan.goal,
    '',
    ...sections,
    '',
    '## 最终验收',
    '',
    finalChecks,
    '',
    '## 方案假设与限制',
    '',
    assumptions,
    '- 本报告由本地规则生成，仅包含结果摘要；完整 AI 返回正文保存在本地任务会话中。',
  ].join('\n')

  return {
    ok: true,
    markdown,
    fileName: `${safeFileName(session.plan.title)}-${session.completedAt.slice(0, 10)}.md`,
  }
}
