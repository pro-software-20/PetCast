import { useState } from 'react'
import { buildManualTaskPrompt } from '../orchestration/manualTaskPrompt'
import { LOCAL_PROVIDER_PROFILE } from '../orchestration/providerProfiles'
import { generateTaskSessionReport } from '../orchestration/taskReport'
import {
  canEditTaskDependencies,
  updateTaskSession,
  type TaskSessionAction,
} from '../orchestration/taskSession'
import type {
  ProviderId,
  ProviderProfile,
  TaskSessionV1,
  TaskStatus,
  VerificationStatus,
} from '../types/taskOrchestration'
import { copyText } from '../utils/copyText'

export interface TaskPlanCardsProps {
  session: TaskSessionV1
  providers: ProviderProfile[]
  onSessionChange: (session: TaskSessionV1, persistImmediately?: boolean) => void
}

type CopyStatus = 'idle' | 'success' | 'error'

const statusLabels: Record<TaskStatus, string> = {
  waiting: '等待依赖',
  ready: '已就绪',
  running: '进行中',
  'needs-input': '需要信息',
  review: '待验收',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

const verificationLabels: Record<VerificationStatus, string> = {
  passed: '通过',
  failed: '失败',
  'not-run': '未执行',
}

const categoryLabels = {
  planning: '方案规划',
  coding: '代码实现',
  testing: '测试验证',
  research: '资料研究',
  analysis: '分析推理',
  writing: '内容写作',
  review: '复核润色',
  vision: '视觉理解',
  general: '通用任务',
} as const

const confidenceLabels = {
  high: '高可信',
  medium: '中可信',
  low: '低可信',
} as const

const formatFile = (file: TaskSessionV1['plan']['tasks'][number]['files']['inputs'][number]) => (
  file.kind === 'workspace'
    ? file.path
    : `${file.name}（${file.type}，${file.size.toLocaleString()} B）`
)

const displayPaths = (paths: string[], emptyLabel: string) => (
  paths.length > 0 ? paths.join('、') : emptyLabel
)

const downloadMarkdown = (markdown: string, fileName: string) => {
  const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

export function TaskPlanCards({ session, providers, onSessionChange }: TaskPlanCardsProps) {
  const [copyStatuses, setCopyStatuses] = useState<Record<string, CopyStatus>>({})
  const [actionError, setActionError] = useState<string | null>(null)
  const [reportCopyStatus, setReportCopyStatus] = useState<CopyStatus>('idle')
  const manualProviders = providers.filter(provider => provider.executionModes.includes('manual'))
  const selectableProviders = manualProviders.some(provider => provider.id === 'local')
    ? manualProviders
    : [LOCAL_PROVIDER_PROFILE, ...manualProviders]
  const completedCount = session.runs.filter(run => run.status === 'done').length
  const readyCount = session.runs.filter(run => run.status === 'ready').length
  const dependenciesEditable = canEditTaskDependencies(session)
  const allTasksDone = completedCount === session.runs.length
  const report = session.completedAt ? generateTaskSessionReport(session) : null

  const applyAction = (action: TaskSessionAction, persistImmediately = true) => {
    const outcome = updateTaskSession(session, action)
    if (!outcome.ok) {
      setActionError(outcome.message)
      return false
    }
    setActionError(null)
    onSessionChange(outcome.session, persistImmediately)
    return true
  }

  const copyTaskPrompt = async (taskId: string, text: string, status: TaskStatus) => {
    const copied = await copyText(text)
    setCopyStatuses(current => ({ ...current, [taskId]: copied ? 'success' : 'error' }))
    if (copied && status === 'ready') applyAction({ type: 'start', taskId })
  }

  const updateVerification = (taskId: string, index: number, status: VerificationStatus) => {
    const run = session.runs.find(candidate => candidate.taskId === taskId)
    if (!run) return
    const verification = run.draft.verification.map((item, itemIndex) => (
      itemIndex === index ? { ...item, status } : item
    ))
    applyAction({ type: 'update-draft', taskId, draft: { verification } }, false)
  }

  const copyReport = async () => {
    if (!report?.ok) return
    setReportCopyStatus(await copyText(report.markdown) ? 'success' : 'error')
  }

  return (
    <section className="task-plan-panel" aria-labelledby="task-plan-title">
      <header className="task-plan-header">
        <span> MANUAL AI PLAN </span>
        <h2 id="task-plan-title">人工 AI 任务方案</h2>
        <p>{session.plan.title}</p>
      </header>

      <div className="task-plan-progress" aria-label={`已完成 ${completedCount} / ${session.runs.length}`}>
        <span><strong>{completedCount}</strong> / {session.runs.length} 已完成</span>
        <div><i style={{ width: `${(completedCount / session.runs.length) * 100}%` }} /></div>
      </div>

      <div className={`task-dependency-summary${dependenciesEditable ? '' : ' is-locked'}`}>
        <strong>{readyCount > 1 ? `当前 ${readyCount} 个任务可并行开始` : `当前 ${readyCount} 个任务可开始`}</strong>
        <span>
          {dependenciesEditable
            ? '开始任何任务前，可以在任务卡中调整前置任务。'
            : '已有任务开始，依赖关系已锁定；需要调整时请新建任务。'}
        </span>
      </div>

      <div className="task-plan-goal">
        <strong>总体目标</strong>
        <p>{session.plan.goal}</p>
      </div>

      {actionError && <p className="task-plan-error" role="alert">{actionError}</p>}

      <ol className="task-plan-list">
        {session.plan.tasks.map((task, index) => {
          const run = session.runs.find(candidate => candidate.taskId === task.id)
          if (!run) return null
          const selectedProviderId = run.assignedProviderId
          const selectedKnown = selectableProviders.some(provider => provider.id === selectedProviderId)
          const recommendedProviderName = selectableProviders.find(
            provider => provider.id === task.recommendedProviderId,
          )?.displayName ?? task.recommendedProviderId
          const manuallyOverridden = selectedProviderId !== task.recommendedProviderId
          const dependencyResults = task.dependsOn.flatMap(dependencyId => {
            const result = session.runs.find(candidate => candidate.taskId === dependencyId)?.result
            return result ? [result] : []
          })
          const prompt = buildManualTaskPrompt(task, session.plan, selectedProviderId, dependencyResults)
          const copyStatus = copyStatuses[task.id] ?? 'idle'
          const dependencyNames = task.dependsOn.map(dependencyId => (
            session.plan.tasks.find(candidate => candidate.id === dependencyId)?.title ?? dependencyId
          ))
          const earlierTasks = session.plan.tasks.slice(0, index)
          const editable = run.status === 'running' || run.status === 'needs-input'
          const canCopy = ['ready', 'running', 'needs-input'].includes(run.status)

          return (
            <li className={`task-plan-card is-${run.status}`} key={task.id}>
              <header>
                <span>任务 {index + 1}</span>
                <strong>{task.title}</strong>
                <em className={`task-run-status is-${run.status}`}>{statusLabels[run.status]}</em>
              </header>
              <p className="task-plan-description">{task.description}</p>
              {run.statusMessage && <p className="task-run-message">{run.statusMessage}</p>}

              <div className="task-plan-assignment">
                <label htmlFor={`task-provider-${task.id}`}>本次复制给</label>
                <select
                  id={`task-provider-${task.id}`}
                  value={selectedProviderId}
                  disabled={!['waiting', 'ready'].includes(run.status)}
                  onChange={event => applyAction({
                    type: 'assign-provider',
                    taskId: task.id,
                    providerId: event.target.value as ProviderId,
                  })}
                >
                  {!selectedKnown && <option value={selectedProviderId}>{selectedProviderId}</option>}
                  {selectableProviders.map(provider => (
                    <option key={provider.id} value={provider.id}>
                      {provider.displayName}{provider.id === task.recommendedProviderId ? '（推荐）' : ''}
                    </option>
                  ))}
                </select>
                <small>人工复制 · 第 {run.attempt} 次</small>
                <div className="task-provider-recommendation">
                  {task.providerRecommendation
                    ? <>
                      <strong>
                        推荐：{recommendedProviderName} · {categoryLabels[task.providerRecommendation.category]} · {confidenceLabels[task.providerRecommendation.confidence]}
                      </strong>
                      {manuallyOverridden && <em>已人工改选</em>}
                      <p>{task.providerRecommendation.reason}</p>
                    </>
                    : <p>旧会话未记录推荐依据；仍可按实际需要人工选择 AI。</p>}
                </div>
              </div>

              <fieldset className="task-dependency-editor" disabled={!dependenciesEditable}>
                <legend>前置任务</legend>
                {earlierTasks.length === 0
                  ? <p>无前置任务，可立即开始。</p>
                  : <>
                    <div>
                      {earlierTasks.map((candidate, candidateIndex) => (
                        <label key={candidate.id}>
                          <input
                            type="checkbox"
                            checked={task.dependsOn.includes(candidate.id)}
                            onChange={(event) => {
                              const nextDependencies = event.target.checked
                                ? [...task.dependsOn, candidate.id]
                                : task.dependsOn.filter(dependencyId => dependencyId !== candidate.id)
                              const orderedDependencies = earlierTasks
                                .filter(earlierTask => nextDependencies.includes(earlierTask.id))
                                .map(earlierTask => earlierTask.id)
                              applyAction({
                                type: 'set-task-dependencies',
                                taskId: task.id,
                                dependsOn: orderedDependencies,
                              })
                            }}
                          />
                          <span>任务 {candidateIndex + 1}：{candidate.title}</span>
                        </label>
                      ))}
                    </div>
                    <small>{dependencyNames.length ? `等待：${dependencyNames.join('、')}` : '未选择前置任务，可与其他根任务并行。'}</small>
                  </>}
              </fieldset>

              <dl className="task-plan-meta">
                <div><dt>前置依赖</dt><dd>{dependencyNames.length ? dependencyNames.join('、') : '无，可立即开始'}</dd></div>
                <div><dt>输入文件</dt><dd>{task.files.inputs.length ? task.files.inputs.map(formatFile).join('、') : '未提供'}</dd></div>
                <div><dt>允许修改</dt><dd>{displayPaths(task.files.allowedWritePaths, '未授权写入；修改前需确认')}</dd></div>
                <div><dt>禁止修改</dt><dd>{displayPaths(task.files.forbiddenPaths, '未单独指定；仍不得超出允许范围')}</dd></div>
                <div><dt>输出位置</dt><dd>{displayPaths(task.files.outputPaths, '待用户确认')}</dd></div>
              </dl>

              <details className="task-plan-prompt">
                <summary>查看将要复制的完整 Prompt</summary>
                <pre>{prompt}</pre>
              </details>

              <div className="task-plan-copy-row">
                <button
                  type="button"
                  className="task-analysis-copy"
                  disabled={!canCopy}
                  onClick={() => void copyTaskPrompt(task.id, prompt, run.status)}
                >
                  {copyStatus === 'success' ? '已复制' : run.status === 'ready' ? '复制并开始任务' : '再次复制任务 Prompt'}
                </button>
                {copyStatus !== 'idle' && (
                  <span className={`task-analysis-copy-status is-${copyStatus}`} role={copyStatus === 'error' ? 'alert' : 'status'}>
                    {copyStatus === 'success' ? '可粘贴到所选 AI。' : '复制失败，任务尚未开始。'}
                  </span>
                )}
              </div>

              {(editable || run.status === 'review' || run.status === 'done' || run.status === 'failed') && (
                <section className="task-result-editor">
                  <label htmlFor={`task-output-${task.id}`}>AI 返回结果</label>
                  <textarea
                    id={`task-output-${task.id}`}
                    value={run.draft.outputText}
                    disabled={!editable}
                    maxLength={50_000}
                    rows={6}
                    onChange={event => applyAction({ type: 'update-draft', taskId: task.id, draft: { outputText: event.target.value } }, false)}
                    placeholder="将外部 AI 返回的完整结果粘贴到这里……"
                  />
                  <small>{run.draft.outputText.length.toLocaleString()} / 50,000 字符</small>

                  <label htmlFor={`task-files-${task.id}`}>实际修改文件（每行一个工作区相对路径，可选）</label>
                  <textarea
                    id={`task-files-${task.id}`}
                    value={run.draft.changedFiles.join('\n')}
                    disabled={!editable}
                    rows={3}
                    onChange={event => applyAction({
                      type: 'update-draft',
                      taskId: task.id,
                      draft: { changedFiles: event.target.value.split(/\r?\n/) },
                    }, false)}
                    placeholder="例如：src/components/Example.tsx"
                  />

                  <fieldset disabled={!editable}>
                    <legend>逐项验收</legend>
                    {run.draft.verification.map((item, checkIndex) => (
                      <label key={item.label}>
                        <span>{item.label}</span>
                        <select value={item.status} onChange={event => updateVerification(task.id, checkIndex, event.target.value as VerificationStatus)}>
                          {Object.entries(verificationLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                        </select>
                      </label>
                    ))}
                  </fieldset>

                  <label htmlFor={`task-note-${task.id}`}>人工备注（可选）</label>
                  <textarea
                    id={`task-note-${task.id}`}
                    value={run.draft.reviewNote}
                    disabled={!editable}
                    rows={2}
                    onChange={event => applyAction({ type: 'update-draft', taskId: task.id, draft: { reviewNote: event.target.value } }, false)}
                  />
                </section>
              )}

              <div className="task-run-actions">
                {['ready', 'waiting'].includes(run.status) && <button type="button" onClick={() => applyAction({ type: 'cancel', taskId: task.id })}>取消任务</button>}
                {run.status === 'running' && <>
                  <button type="button" className="is-primary" onClick={() => applyAction({ type: 'submit-result', taskId: task.id })}>提交待验收</button>
                  <button type="button" onClick={() => applyAction({ type: 'needs-input', taskId: task.id, message: run.draft.reviewNote })}>需要补充信息</button>
                  <button type="button" onClick={() => applyAction({ type: 'fail', taskId: task.id, message: run.draft.reviewNote })}>标记失败</button>
                  <button type="button" onClick={() => applyAction({ type: 'cancel', taskId: task.id })}>取消</button>
                </>}
                {run.status === 'needs-input' && <>
                  <button type="button" className="is-primary" onClick={() => applyAction({ type: 'resume', taskId: task.id })}>信息已补充，继续</button>
                  <button type="button" onClick={() => applyAction({ type: 'fail', taskId: task.id, message: run.draft.reviewNote })}>标记失败</button>
                  <button type="button" onClick={() => applyAction({ type: 'cancel', taskId: task.id })}>取消</button>
                </>}
                {run.status === 'review' && <>
                  <button type="button" className="is-primary" onClick={() => applyAction({ type: 'accept', taskId: task.id })}>验收通过</button>
                  <button type="button" onClick={() => applyAction({ type: 'request-changes', taskId: task.id, message: run.draft.reviewNote })}>退回修改</button>
                  <button type="button" onClick={() => applyAction({ type: 'fail', taskId: task.id, message: run.draft.reviewNote })}>标记失败</button>
                </>}
                {['failed', 'cancelled'].includes(run.status) && <button type="button" className="is-primary" onClick={() => applyAction({ type: 'retry', taskId: task.id })}>重试任务</button>}
              </div>
            </li>
          )
        })}
      </ol>

      <section className="task-plan-footer">
        <h3>最终验收</h3>
        {!allTasksDone && <p>完成并验收全部任务后，可进行最终验收并生成报告。</p>}
        {session.finalVerification.map((item, index) => (
          <label className="task-final-check" key={item.label}>
            <input
              type="checkbox"
              checked={item.status === 'passed'}
              disabled={!allTasksDone || Boolean(session.completedAt)}
              onChange={event => applyAction({
                type: 'set-final-verification',
                index,
                status: event.target.checked ? 'passed' : 'not-run',
              })}
            />
            <span>{item.label}</span>
          </label>
        ))}

        {report?.ok && (
          <div className="task-report-actions">
            <strong>任务会话已完成，可以导出最终报告。</strong>
            <button type="button" onClick={() => void copyReport()}>{reportCopyStatus === 'success' ? '报告已复制' : '复制报告'}</button>
            <button type="button" onClick={() => downloadMarkdown(report.markdown, report.fileName)}>下载 Markdown</button>
            {reportCopyStatus === 'error' && <span role="alert">复制失败，请使用下载功能。</span>}
          </div>
        )}

        <details>
          <summary>本方案的估算假设</summary>
          <ul>{session.plan.assumptions.map(assumption => <li key={assumption}>{assumption}</li>)}</ul>
        </details>
      </section>
    </section>
  )
}
