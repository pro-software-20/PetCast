import { useEffect, useMemo, useRef, useState } from 'react'
import type { WorkspaceSnapshot } from '../../electron/workspaceProtocol'
import type { PreparedCodexTaskExecution, TaskExecutionArtifactView } from '../../electron/taskExecutionProtocol'
import { buildManualTaskPrompt } from '../orchestration/manualTaskPrompt'
import { LOCAL_PROVIDER_PROFILE } from '../orchestration/providerProfiles'
import { generateTaskSessionReport } from '../orchestration/taskReport'
import { getTaskWorkspacePathScope, workspacePathScopesEqual } from '../orchestration/taskPathScope'
import {
  canEditTaskDependencies,
  canEditTaskPlan,
  updateTaskSession,
  type TaskSessionAction,
} from '../orchestration/taskSession'
import type {
  AutomaticTaskExecutionState,
  ProviderId,
  ProviderProfile,
  TaskSessionV1,
  TaskStatus,
  VerificationStatus,
} from '../types/taskOrchestration'
import { copyText } from '../utils/copyText'
import { createTaskLedger } from '../history/TaskLedger'
import { TaskExecutionRecorder, TaskPersistenceError } from '../history/TaskExecutionRecorder'
import { TaskDefinitionEditor } from './TaskDefinitionEditor'
import { WorkspaceScopePicker } from './WorkspaceScopePicker'
import { WorkspaceScopeSummary } from './WorkspaceScopeSummary'
import {
  getCodexExecutionAccess,
  type CodexEnvironmentState,
} from '../codex/codexEnvironment'

export interface TaskPlanCardsProps {
  session: TaskSessionV1
  providers: ProviderProfile[]
  onSessionChange: (session: TaskSessionV1, persistImmediately?: boolean) => void
  codexEnvironment?: CodexEnvironmentState
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

const taskFocusPriority: TaskStatus[] = ['needs-input', 'review', 'running', 'ready', 'waiting', 'failed', 'cancelled', 'done']

const findFocusTaskId = (session: TaskSessionV1, excludedTaskId?: string) => {
  for (const status of taskFocusPriority) {
    const run = session.runs.find(candidate => candidate.taskId !== excludedTaskId && candidate.status === status)
    if (run) return run.taskId
  }
  return session.runs[0]?.taskId ?? null
}

const nextStepText = (
  status: TaskStatus,
  dependencyNames: string[],
  automaticState?: AutomaticTaskExecutionState,
  automaticCandidate = false,
) => {
  if (automaticState === 'running') return '下一步：等待 Codex 完成，或取消自动执行。'
  if (automaticState === 'review') return '下一步：查看 diff，并应用或丢弃文件改动。'
  if (status === 'waiting') return `下一步：等待 ${dependencyNames.join('、') || '前置任务'} 完成。`
  if (status === 'ready') return automaticCandidate
    ? '下一步：可复制给外部 AI 后开始跟踪，或使用 Codex 隔离执行。'
    : '下一步：复制 Prompt；实际交给 AI 后开始跟踪。'
  if (status === 'running') return '下一步：粘贴 AI 结果并提交待验收。'
  if (status === 'needs-input') return '下一步：补充信息后继续任务。'
  if (status === 'review') return '下一步：逐项检查并决定验收或退回。'
  if (status === 'done') return '任务已完成，可展开查看只读结果。'
  if (status === 'failed' || status === 'cancelled') return '下一步：检查原因并按需重试。'
  return '查看任务详情。'
}

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

export function TaskPlanCards({ session, providers, onSessionChange, codexEnvironment = { status: 'browser' } }: TaskPlanCardsProps) {
  const [copyStatuses, setCopyStatuses] = useState<Record<string, CopyStatus>>({})
  const [actionError, setActionError] = useState<string | null>(null)
  const [reportCopyStatus, setReportCopyStatus] = useState<CopyStatus>('idle')
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot | undefined>()
  const [pendingWorkspace, setPendingWorkspace] = useState<WorkspaceSnapshot | undefined>()
  const [workspaceError, setWorkspaceError] = useState<string | null>(null)
  const [workspaceLoading, setWorkspaceLoading] = useState(false)
  const [defaultScopeOpen, setDefaultScopeOpen] = useState(false)
  const [confirmApplyDefault, setConfirmApplyDefault] = useState(false)
  const workspaceRequest = useRef<string | null>(null)
  const sessionRef = useRef(session)
  sessionRef.current = session
  const ledger = useMemo(() => createTaskLedger(window.petcast), [])
  const [preparedExecution, setPreparedExecution] = useState<{
    taskId: string
    prompt: string
    prepared: PreparedCodexTaskExecution
  } | null>(null)
  const [preparingExecution, setPreparingExecution] = useState<{
    taskId: string
    requestId: string
  } | null>(null)
  const [executionProgress, setExecutionProgress] = useState<string | null>(null)
  const [executionBusy, setExecutionBusy] = useState(false)
  const [artifactViews, setArtifactViews] = useState<Record<string, TaskExecutionArtifactView>>({})
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(() => findFocusTaskId(session))
  const cancelRequested = useRef(new Set<string>())
  const preparingRequest = useRef<string | null>(null)
  const preparedExecutionRef = useRef(preparedExecution)
  const executionSessionId = useRef(session.id)
  preparedExecutionRef.current = preparedExecution
  const manualProviders = providers.filter(provider => provider.executionModes.includes('manual'))
  const selectableProviders = manualProviders.some(provider => provider.id === 'local')
    ? manualProviders
    : [LOCAL_PROVIDER_PROFILE, ...manualProviders]
  const completedCount = session.runs.filter(run => run.status === 'done').length
  const readyCount = session.runs.filter(run => run.status === 'ready').length
  const dependenciesEditable = canEditTaskDependencies(session) && !preparedExecution && !preparingExecution
  const planEditable = canEditTaskPlan(session) && !preparedExecution && !preparingExecution
  const allTasksDone = completedCount === session.runs.length
  const report = session.completedAt ? generateTaskSessionReport(session) : null
  const defaultScope = session.plan.workspace?.defaultScope
  const tasksWithCustomScope = defaultScope
    ? session.plan.tasks.filter(task => !workspacePathScopesEqual(getTaskWorkspacePathScope(task.files), defaultScope)).length
    : session.plan.tasks.length
  const codexExecutionAccess = getCodexExecutionAccess(codexEnvironment)

  useEffect(() => () => {
    const requestId = workspaceRequest.current
    workspaceRequest.current = null
    if (requestId) window.petcast?.cancelTaskWorkspace?.(requestId)
  }, [])

  useEffect(() => {
    if (executionSessionId.current === session.id) return
    const requestId = preparingRequest.current
    if (requestId) window.petcast?.cancelCodexTaskExecution?.(requestId)
    const prepared = preparedExecutionRef.current
    if (prepared) window.petcast?.cancelCodexTaskExecution?.(prepared.prepared.executionId)
    preparingRequest.current = null
    setPreparingExecution(null)
    setPreparedExecution(null)
    setExecutionBusy(false)
    setExecutionProgress(null)
    setExpandedTaskId(findFocusTaskId(session))
    executionSessionId.current = session.id
  }, [session.id])

  const applyAction = (action: TaskSessionAction, persistImmediately = true) => {
    const previous = sessionRef.current
    const outcome = updateTaskSession(previous, action)
    if (!outcome.ok) {
      setActionError(outcome.message)
      if ('taskId' in action) setExpandedTaskId(action.taskId)
      return false
    }
    setActionError(null)
    sessionRef.current = outcome.session
    onSessionChange(outcome.session, persistImmediately)
    if ('taskId' in action) {
      if (action.type === 'accept') {
        const newlyReady = outcome.session.runs.find(run => (
          run.status === 'ready'
          && previous.runs.find(candidate => candidate.taskId === run.taskId)?.status !== 'ready'
        ))
        setExpandedTaskId(newlyReady?.taskId ?? findFocusTaskId(outcome.session, action.taskId))
      } else {
        setExpandedTaskId(action.taskId)
      }
    }
    return true
  }

  useEffect(() => window.petcast?.onTaskExecutionEvent?.((event) => {
    if (preparedExecutionRef.current?.prepared.executionId === event.executionId
      || preparingRequest.current === event.executionId) {
      setExecutionProgress(event.message)
    }
    if (event.code !== 'ARTIFACT_EXPIRED') return
    const run = sessionRef.current.runs.find(candidate => (
      candidate.automaticExecution?.executionId === event.executionId
    ))
    if (!run || run.automaticExecution?.state !== 'review') return
    setExpandedTaskId(run.taskId)
    setArtifactViews(current => {
      const next = { ...current }
      delete next[run.taskId]
      return next
    })
    applyAction({ type: 'interrupt-automatic', taskId: run.taskId, message: event.message })
    setActionError(event.message)
  }), [])

  useEffect(() => () => {
    const requestId = preparingRequest.current
    if (requestId) window.petcast?.cancelCodexTaskExecution?.(requestId)
    const prepared = preparedExecutionRef.current
    if (prepared) window.petcast?.cancelCodexTaskExecution?.(prepared.prepared.executionId)
  }, [])

  const prepareAutomaticExecution = async (
    taskId: string,
    prompt: string,
    category: 'coding' | 'testing',
  ) => {
    const current = sessionRef.current
    const task = current.plan.tasks.find(candidate => candidate.id === taskId)
    if (!task || !current.plan.workspace || !codexExecutionAccess.available
      || !codexExecutionAccess.scopeId || !window.petcast?.prepareCodexTaskExecution) return
    setExpandedTaskId(taskId)
    const requestId = `prepare-${globalThis.crypto.randomUUID()}`
    preparingRequest.current = requestId
    setPreparingExecution({ taskId, requestId })
    setExecutionBusy(true)
    setActionError(null)
    setExecutionProgress('正在准备隔离副本…')
    try {
      const scope = getTaskWorkspacePathScope(task.files)
      const outcome = await window.petcast.prepareCodexTaskExecution({
        requestId,
        taskId,
        workspaceId: current.plan.workspace.id,
        expectedScopeId: codexExecutionAccess.scopeId,
        authMode: codexExecutionAccess.authMode ?? 'chatgpt-oauth',
        prompt,
        category,
        scope,
        dependencySummaries: task.dependsOn.flatMap(dependencyId => {
          const result = current.runs.find(run => run.taskId === dependencyId)?.result
          return result ? [result.summary] : []
        }),
      })
      if (preparingRequest.current !== requestId) {
        if (outcome.ok) window.petcast.cancelCodexTaskExecution?.(outcome.value.executionId)
        return
      }
      if (!outcome.ok) {
        setActionError(outcome.message)
        return
      }
      setPreparedExecution({ taskId, prompt, prepared: outcome.value })
      setExecutionProgress('隔离副本和账号已验证；确认后才会调用 Codex。')
    } catch {
      if (preparingRequest.current === requestId) setActionError('Codex 准备失败，请稍后重试。')
    } finally {
      if (preparingRequest.current === requestId) {
        preparingRequest.current = null
        setPreparingExecution(null)
        setExecutionBusy(false)
      }
    }
  }

  const cancelPreparingExecution = () => {
    const requestId = preparingRequest.current
    if (!requestId) return
    preparingRequest.current = null
    window.petcast?.cancelCodexTaskExecution?.(requestId)
    setPreparingExecution(null)
    setExecutionBusy(false)
    setExecutionProgress('已取消准备。')
  }

  const cancelPreparedExecution = () => {
    if (!preparedExecution) return
    window.petcast?.cancelCodexTaskExecution?.(preparedExecution.prepared.executionId)
    setPreparedExecution(null)
    setExecutionProgress(null)
  }

  const runPreparedExecution = async () => {
    if (!preparedExecution || !codexExecutionAccess.available
      || !codexExecutionAccess.scopeId || !window.petcast?.runCodexTaskExecution) return
    const { taskId, prepared } = preparedExecution
    const current = sessionRef.current
    const task = current.plan.tasks.find(candidate => candidate.id === taskId)
    const run = current.runs.find(candidate => candidate.taskId === taskId)
    if (!task || !run || !applyAction({ type: 'start-automatic', taskId, executionId: prepared.executionId, model: prepared.model })) return
    setExecutionBusy(true)
    setExecutionProgress('正在写入执行账本…')
    const recorder = new TaskExecutionRecorder(ledger, {
      source: 'real',
      scopeId: codexExecutionAccess.scopeId,
      id: `auto-${current.id}-${taskId}-${run.attempt + 1}`.replace(/[^a-zA-Z0-9:._-]/g, '-'),
      label: task.title.slice(0, 100),
      category: task.providerRecommendation?.category ?? 'coding',
    })
    let providerResult: Awaited<ReturnType<NonNullable<typeof window.petcast>['runCodexTaskExecution']>> | undefined
    try {
      const value = await recorder.call({
        id: prepared.executionId,
        provider: 'codex',
        model: prepared.model,
        attempt: run.attempt + 1,
      }, async () => {
        providerResult = await window.petcast!.runCodexTaskExecution(prepared.executionId)
        if (!providerResult.ok) throw new Error(providerResult.message)
        const usage = providerResult.value.usage
        return {
          value: providerResult.value,
          usage: usage ? { ...usage, basis: 'provider-reported' as const } : null,
          cost: null,
        }
      })
      await recorder.finish('succeeded')
      let cleanupWarning: string | undefined
      if (!value.changedFiles.length) {
        try {
          const cleanup = await window.petcast.discardTaskExecutionArtifact(value.artifactId)
          if (!cleanup.ok) cleanupWarning = cleanup.message
        } catch {
          cleanupWarning = 'Codex 已完成且未修改文件，但临时副本清理失败；应用退出时会再次清理。'
        }
      }
      const completed = applyAction({
        type: 'complete-automatic',
        taskId,
        ...(value.changedFiles.length ? { artifactId: value.artifactId } : {}),
        summary: value.summary,
        outputText: value.outputText || value.summary,
        changedFiles: value.changedFiles,
        ...(value.usage ? { usage: { inputTokens: value.usage.inputTokens, outputTokens: value.usage.outputTokens } } : {}),
      })
      if (!completed) {
        if (value.changedFiles.length) {
          try { await window.petcast.discardTaskExecutionArtifact(value.artifactId) }
          catch { /* the main process keeps failed cleanup retryable */ }
        }
        applyAction({
          type: 'interrupt-automatic',
          taskId,
          message: '执行结果未能写入当前会话，文件产物已丢弃；请人工核对执行账本。',
        })
        setActionError('执行结果未能写入当前会话，未保留待应用改动。')
        setPreparedExecution(null)
        return
      }
      if (value.changedFiles.length) {
        try {
          const artifact = await window.petcast.readTaskExecutionArtifact(value.artifactId)
          if (artifact.ok) setArtifactViews(currentViews => ({ ...currentViews, [taskId]: artifact.value }))
          else setActionError(artifact.message)
        } catch {
          setActionError('读取 Codex 文件差异失败，请稍后重试。')
        }
      }
      setPreparedExecution(null)
      setExecutionProgress('执行完成；AI 验证结果不会替代人工验收。')
      if (cleanupWarning) setActionError(cleanupWarning)
    } catch (error) {
      const cancelled = cancelRequested.current.delete(prepared.executionId)
      if (providerResult?.ok) {
        try { await window.petcast?.discardTaskExecutionArtifact?.(providerResult.value.artifactId) }
        catch { /* keep the original safe error */ }
      } else {
        window.petcast?.cancelCodexTaskExecution?.(prepared.executionId)
      }
      try { await recorder.finish(cancelled ? 'cancelled' : 'failed') } catch { /* preserve first error */ }
      applyAction({
        type: 'interrupt-automatic',
        taskId,
        message: error instanceof TaskPersistenceError
          ? error.message
          : cancelled ? 'Codex 执行已取消。' : '自动执行未完成；请核对执行账本后再决定是否重试。',
      })
      setActionError(error instanceof TaskPersistenceError
        ? error.message
        : providerResult && !providerResult.ok ? providerResult.message : 'Codex 自动执行失败。')
      setPreparedExecution(null)
    } finally {
      setExecutionBusy(false)
    }
  }

  const cancelRunningExecution = (executionId: string) => {
    cancelRequested.current.add(executionId)
    window.petcast?.cancelCodexTaskExecution?.(executionId)
    setExecutionProgress('正在安全中断 Codex…')
  }

  const resolveArtifact = async (taskId: string, apply: boolean) => {
    const run = sessionRef.current.runs.find(candidate => candidate.taskId === taskId)
    const artifactId = run?.automaticExecution?.artifactId
    if (!artifactId || !window.petcast) return
    setExecutionBusy(true)
    setActionError(null)
    try {
      const outcome = apply
        ? await window.petcast.applyTaskExecutionArtifact(artifactId)
        : await window.petcast.discardTaskExecutionArtifact(artifactId)
      if (!outcome.ok) {
        setActionError(outcome.message)
        if (outcome.code === 'ARTIFACT_EXPIRED') {
          applyAction({ type: 'interrupt-automatic', taskId, message: outcome.message })
        }
        return
      }
      applyAction({ type: apply ? 'apply-automatic' : 'discard-automatic', taskId })
      setArtifactViews(current => {
        const next = { ...current }
        delete next[taskId]
        return next
      })
    } catch {
      setActionError(apply ? '应用 Codex 改动失败，请确认原文件未变化后重试。' : '丢弃 Codex 改动失败，请稍后重试。')
    } finally {
      setExecutionBusy(false)
    }
  }

  const readArtifact = async (taskId: string, artifactId: string) => {
    if (!window.petcast) return
    setExecutionBusy(true)
    setActionError(null)
    try {
      const outcome = await window.petcast.readTaskExecutionArtifact(artifactId)
      if (!outcome.ok) {
        setActionError(outcome.message)
        if (outcome.code === 'ARTIFACT_EXPIRED') {
          applyAction({ type: 'interrupt-automatic', taskId, message: outcome.message })
        }
        return
      }
      setArtifactViews(current => ({ ...current, [taskId]: outcome.value }))
    } catch {
      setActionError('读取 Codex 文件差异失败，请稍后重试。')
    } finally {
      setExecutionBusy(false)
    }
  }

  const copyTaskPrompt = async (taskId: string, text: string) => {
    const copied = await copyText(text)
    setCopyStatuses(current => ({ ...current, [taskId]: copied ? 'success' : 'error' }))
  }

  const updateVerification = (taskId: string, index: number, status: VerificationStatus) => {
    const run = session.runs.find(candidate => candidate.taskId === taskId)
    if (!run) return
    if (run.status === 'review' && run.automaticExecution && run.automaticExecution.state !== 'review') {
      applyAction({ type: 'set-automatic-verification', taskId, index, status })
      return
    }
    const verification = run.draft.verification.map((item, itemIndex) => (
      itemIndex === index ? { ...item, status } : item
    ))
    applyAction({ type: 'update-draft', taskId, draft: { verification } }, false)
  }

  const copyReport = async () => {
    if (!report?.ok) return
    setReportCopyStatus(await copyText(report.markdown) ? 'success' : 'error')
  }

  const selectWorkspace = async () => {
    if (!window.petcast?.selectTaskWorkspace) {
      setWorkspaceError('工作区选择仅桌面版可用。')
      return
    }
    const requestId = `workspace-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`
    workspaceRequest.current = requestId
    setWorkspaceLoading(true)
    setWorkspaceError(null)
    try {
      const outcome = await window.petcast.selectTaskWorkspace(requestId)
      if (workspaceRequest.current !== requestId) return
      if (!outcome.ok) {
        if (outcome.code !== 'CANCELLED') setWorkspaceError(outcome.message)
        return
      }
      if (session.plan.workspace && session.plan.workspace.id !== outcome.workspace.workspaceId) {
        setPendingWorkspace(outcome.workspace)
        return
      }
      if (applyAction({
        type: 'set-workspace',
        workspace: { id: outcome.workspace.workspaceId, displayName: outcome.workspace.displayName },
      })) {
        setWorkspace(outcome.workspace)
      }
    } finally {
      if (workspaceRequest.current === requestId) {
        workspaceRequest.current = null
        setWorkspaceLoading(false)
      }
    }
  }

  const cancelWorkspaceScan = () => {
    if (workspaceRequest.current) window.petcast?.cancelTaskWorkspace?.(workspaceRequest.current)
  }

  const confirmWorkspaceSwitch = () => {
    if (!pendingWorkspace) return
    if (applyAction({
      type: 'set-workspace',
      workspace: { id: pendingWorkspace.workspaceId, displayName: pendingWorkspace.displayName },
    })) {
      setWorkspace(pendingWorkspace)
      setPendingWorkspace(undefined)
    }
  }

  const saveDefaultScope = (scope: NonNullable<typeof defaultScope>) => {
    const firstDefault = !defaultScope
    if (applyAction({ type: 'set-workspace-default-scope', scope, applyToAll: firstDefault })) {
      setDefaultScopeOpen(false)
      setConfirmApplyDefault(false)
    }
  }

  const applyDefaultToAll = () => {
    if (!defaultScope) return
    if (!confirmApplyDefault && tasksWithCustomScope > 0) {
      setConfirmApplyDefault(true)
      return
    }
    if (applyAction({ type: 'set-workspace-default-scope', scope: defaultScope, applyToAll: true })) {
      setConfirmApplyDefault(false)
    }
  }

  return (
    <section className="task-plan-panel" aria-labelledby="task-plan-title">
      <header className="task-plan-header">
        <span> MANUAL AI PLAN </span>
        <h2 id="task-plan-title">人工 AI 任务方案</h2>
        <p>{session.plan.title}</p>
      </header>

      <section className="task-workspace-selector">
        <div>
          <strong>项目工作区</strong>
          <span>{session.plan.workspace?.displayName ?? '尚未选择；不会读取文件内容'}</span>
          {workspace && <small>{workspace.entries.length} 项路径元信息{workspace.truncated ? '（清单已截断）' : ''}</small>}
        </div>
        <button type="button" disabled={!planEditable || workspaceLoading} onClick={() => void selectWorkspace()}>
          {workspaceLoading ? '正在扫描…' : session.plan.workspace ? '重新选择' : '选择项目文件夹'}
        </button>
        {workspaceLoading && <button type="button" onClick={cancelWorkspaceScan}>取消扫描</button>}
        {!window.petcast?.selectTaskWorkspace && <p>工作区选择仅桌面版可用。</p>}
        {workspaceError && <p role="alert">{workspaceError}</p>}
        {workspace?.warnings.map(warning => <p key={warning}>{warning}</p>)}
        {session.plan.workspace && !workspace && <p>已恢复相对路径授权；重新选择同一工作区后可以继续浏览文件清单。</p>}
        {pendingWorkspace && (
          <div className="task-workspace-switch-warning" role="alert">
            <strong>切换为“{pendingWorkspace.displayName}”会清空所有任务的旧工作区路径授权。</strong>
            <button type="button" onClick={confirmWorkspaceSwitch}>确认切换并清空</button>
            <button type="button" onClick={() => setPendingWorkspace(undefined)}>取消</button>
          </div>
        )}
      </section>

      {session.plan.workspace && (
        <section className="task-global-scope">
          <header>
            <div>
              <strong>全局默认文件授权</strong>
              <span>子任务默认继承，特殊任务可单独调整</span>
            </div>
            <button type="button" disabled={!planEditable || !workspace} onClick={() => setDefaultScopeOpen(true)}>
              {defaultScope ? '修改默认范围' : '设置默认范围'}
            </button>
          </header>
          <details className="task-global-scope-details">
            <summary>查看完整授权范围{defaultScope ? '' : '（尚未设置）'}</summary>
            <WorkspaceScopeSummary scope={defaultScope ?? { readPaths: [], allowedWritePaths: [], forbiddenPaths: [], outputPaths: [] }} />
            {defaultScope && tasksWithCustomScope > 0 && (
              <div className="task-global-scope-apply">
                <span>{tasksWithCustomScope} 个任务使用了单独授权。</span>
                <button type="button" disabled={!planEditable} onClick={applyDefaultToAll}>
                  {confirmApplyDefault ? '再次点击确认覆盖' : '应用到所有任务'}
                </button>
                {confirmApplyDefault && <button type="button" onClick={() => setConfirmApplyDefault(false)}>取消</button>}
              </div>
            )}
          </details>
        </section>
      )}

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
          const selectedProviderName = selectableProviders.find(provider => provider.id === selectedProviderId)?.displayName
            ?? selectedProviderId
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
          const verificationEditable = editable || Boolean(
            run.status === 'review' && run.automaticExecution && run.automaticExecution.state !== 'review',
          )
          const canCopy = !preparedExecution && !preparingExecution && ['ready', 'running', 'needs-input'].includes(run.status)
          const automaticCategory = task.providerRecommendation?.category
          const automaticCandidate = Boolean(
            run.status === 'ready'
            && selectedProviderId === 'codex'
            && (automaticCategory === 'coding' || automaticCategory === 'testing'),
          )
          const canPrepareAutomatic = Boolean(
            automaticCandidate
            && workspace
            && workspace.workspaceId === session.plan.workspace?.id
            && codexExecutionAccess.available
            && window.petcast?.prepareCodexTaskExecution,
          )
          const taskArtifact = artifactViews[task.id]
          const expanded = expandedTaskId === task.id
          const taskPanelId = `task-plan-card-body-${task.id}`
          const taskNextStep = nextStepText(run.status, dependencyNames, run.automaticExecution?.state, automaticCandidate)

          return (
            <li className={`task-plan-card is-${run.status}${expanded ? ' is-expanded' : ''}`} key={task.id}>
              <button
                type="button"
                className="task-plan-card-toggle"
                aria-expanded={expanded}
                aria-controls={taskPanelId}
                onClick={() => setExpandedTaskId(current => current === task.id ? null : task.id)}
              >
                <span>任务 {index + 1}</span>
                <strong title={task.title}>{task.title}</strong>
                <em className={`task-run-status is-${run.status}`}>{statusLabels[run.status]}</em>
                <i aria-hidden="true">{expanded ? '−' : '+'}</i>
              </button>
              <div className="task-plan-card-glance">
                <span>AI：{selectedProviderName}{manuallyOverridden ? '（人工改选）' : ''}</span>
                <span>依赖：{dependencyNames.length ? dependencyNames.join('、') : '无，可并行'}</span>
                <strong>{taskNextStep}</strong>
              </div>

              {expanded && <div id={taskPanelId} className="task-plan-card-body">
              <p className="task-plan-description">{task.description}</p>
              {run.statusMessage && <p className="task-run-message" role="status">{run.statusMessage}</p>}

              <div className="task-plan-assignment">
                <label htmlFor={`task-provider-${task.id}`}>子任务执行 AI</label>
                <select
                  id={`task-provider-${task.id}`}
                  value={selectedProviderId}
                  disabled={!['waiting', 'ready'].includes(run.status) || Boolean(preparedExecution) || Boolean(preparingExecution)}
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

              <div className="task-plan-copy-row">
                <button
                  type="button"
                  className="task-analysis-copy"
                  disabled={!canCopy}
                  onClick={() => void copyTaskPrompt(task.id, prompt)}
                >
                  {copyStatus === 'success' ? '已复制' : run.status === 'ready' ? '复制任务 Prompt' : '再次复制任务 Prompt'}
                </button>
                {run.status === 'ready' && (
                  <button
                    type="button"
                    className="is-primary"
                    disabled={Boolean(preparedExecution) || Boolean(preparingExecution)}
                    onClick={() => applyAction({ type: 'start', taskId: task.id })}
                  >
                    已交给 AI，开始跟踪
                  </button>
                )}
                {copyStatus !== 'idle' && (
                  <span className={`task-analysis-copy-status is-${copyStatus}`} role={copyStatus === 'error' ? 'alert' : 'status'}>
                    {copyStatus === 'success' ? '可粘贴到所选 AI；任务仍未开始。' : '复制失败，任务状态未改变。'}
                  </span>
                )}
              </div>

              <details className="task-plan-settings">
                <summary>任务设置与文件授权</summary>
                <div>
                  <TaskDefinitionEditor
                    key={`${task.id}:${session.plan.workspace?.id ?? 'none'}`}
                    task={task}
                    taskType={session.analysisResult.taskType}
                    providers={providers}
                    workspace={workspace}
                    defaultScope={defaultScope}
                    disabled={!planEditable}
                    onSave={definition => applyAction({
                      type: 'update-task-definition',
                      taskId: task.id,
                      task: definition,
                    })}
                  />

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
                    <div><dt>浏览器附件</dt><dd>{task.files.inputs.some(file => file.kind === 'attachment') ? task.files.inputs.filter(file => file.kind === 'attachment').map(formatFile).join('、') : '未提供'}</dd></div>
                  </dl>
                  <WorkspaceScopeSummary
                    scope={getTaskWorkspacePathScope(task.files)}
                    inherited={Boolean(defaultScope && workspacePathScopesEqual(getTaskWorkspacePathScope(task.files), defaultScope))}
                    compact
                  />
                </div>
              </details>

              <details className="task-plan-prompt">
                <summary>查看将要复制的完整 Prompt</summary>
                <pre>{prompt}</pre>
              </details>

              {(automaticCandidate || run.automaticExecution) && (
                <section className="task-codex-execution">
                  <header>
                    <strong>Codex 隔离执行</strong>
                    <span>{run.automaticExecution ? `状态：${run.automaticExecution.state}` : '不会直接修改原项目'}</span>
                  </header>
                  {canPrepareAutomatic && preparedExecution?.taskId !== task.id && preparingExecution?.taskId !== task.id && (
                    <button
                      type="button"
                      disabled={executionBusy || Boolean(preparedExecution) || Boolean(preparingExecution)}
                      onClick={() => void prepareAutomaticExecution(task.id, prompt, automaticCategory as 'coding' | 'testing')}
                    >
                      使用 Codex 执行
                    </button>
                  )}
                  {automaticCandidate && !canPrepareAutomatic && !run.automaticExecution && (
                    <div className="task-codex-unavailable" role="status">
                      <button type="button" disabled>使用 Codex 执行</button>
                      <p>{workspace && workspace.workspaceId === session.plan.workspace?.id
                        ? codexExecutionAccess.message
                        : '请先选择并确认当前项目工作区。'} 人工复制任务 Prompt 仍可使用。</p>
                    </div>
                  )}
                  {preparingExecution?.taskId === task.id && (
                    <div className="task-codex-confirm" role="status">
                      <strong>正在准备隔离副本并核对账号</strong>
                      <p>准备期间不会调用模型；可以随时取消。</p>
                      <button type="button" onClick={cancelPreparingExecution}>取消准备</button>
                    </div>
                  )}
                  {preparedExecution?.taskId === task.id && (
                    <div className="task-codex-confirm" role="dialog" aria-label="确认 Codex 自动执行">
                      <strong>执行前确认</strong>
                      <p>模型：{preparedExecution.prepared.model}；隔离文件：{preparedExecution.prepared.preparedFileCount} 个；网络关闭；不会自动应用改动。</p>
                      <p>{codexExecutionAccess.authMode === 'chatgpt-oauth'
                        ? '使用已连接的 ChatGPT 计划；访问令牌不会发送到页面或写入任务记录。'
                        : '使用本机 Codex 登录实验回退；公开使用时建议连接 ChatGPT。'}</p>
                      <WorkspaceScopeSummary scope={getTaskWorkspacePathScope(task.files)} compact />
                      <details><summary>实际发送给 Codex 的 Prompt</summary><pre>{preparedExecution.prompt}</pre></details>
                      <button type="button" className="is-primary" disabled={executionBusy || !codexExecutionAccess.available} onClick={() => void runPreparedExecution()}>确认并开始</button>
                      <button type="button" disabled={executionBusy} onClick={cancelPreparedExecution}>取消</button>
                    </div>
                  )}
                  {run.automaticExecution?.state === 'running' && (
                    <button type="button" disabled={!executionBusy} onClick={() => cancelRunningExecution(run.automaticExecution!.executionId)}>取消自动执行</button>
                  )}
                  {executionProgress && (preparingExecution?.taskId === task.id || preparedExecution?.taskId === task.id || run.automaticExecution?.state === 'running') && (
                    <p role="status">{executionProgress}</p>
                  )}
                  {run.automaticExecution?.state === 'review' && (
                    <div className="task-codex-artifact">
                      <strong>待处理文件改动：{run.automaticExecution.pendingFileCount} 个</strong>
                      {taskArtifact
                        ? <details open><summary>查看受限 diff</summary><pre>{taskArtifact.diff || '没有文本差异。'}</pre></details>
                        : <button type="button" disabled={executionBusy} onClick={() => {
                          const artifactId = run.automaticExecution?.artifactId
                          if (artifactId) void readArtifact(task.id, artifactId)
                        }}>读取 diff</button>}
                      <p>应用前会再次检查原文件哈希；若队友已修改文件，将拒绝覆盖。</p>
                      <button type="button" className="is-primary" disabled={executionBusy} onClick={() => void resolveArtifact(task.id, true)}>应用改动</button>
                      <button type="button" disabled={executionBusy} onClick={() => void resolveArtifact(task.id, false)}>丢弃改动</button>
                    </div>
                  )}
                  {run.automaticExecution && ['applied', 'discarded'].includes(run.automaticExecution.state) && (
                    <p>{run.automaticExecution.state === 'applied' ? '文件改动已安全应用；仍需逐项人工验收。' : '文件改动已丢弃；可依据文字结果继续人工验收。'}</p>
                  )}
                </section>
              )}

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

                  <fieldset disabled={!verificationEditable}>
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
                {run.status === 'running' && run.automaticExecution?.state !== 'running' && <>
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
                {run.status === 'review' && run.automaticExecution?.state !== 'review' && <>
                  <button type="button" className="is-primary" onClick={() => applyAction({ type: 'accept', taskId: task.id })}>验收通过</button>
                  <button type="button" onClick={() => applyAction({ type: 'request-changes', taskId: task.id, message: run.draft.reviewNote })}>退回修改</button>
                  <button type="button" onClick={() => applyAction({ type: 'fail', taskId: task.id, message: run.draft.reviewNote })}>标记失败</button>
                </>}
                {['failed', 'cancelled'].includes(run.status) && <button type="button" className="is-primary" onClick={() => applyAction({ type: 'retry', taskId: task.id })}>重试任务</button>}
              </div>
              </div>}
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

      {defaultScopeOpen && workspace && (
        <WorkspaceScopePicker
          title="设置全局默认文件范围"
          workspace={workspace}
          initialScope={defaultScope ?? { readPaths: [], allowedWritePaths: [], forbiddenPaths: [], outputPaths: [] }}
          onSave={saveDefaultScope}
          onClose={() => setDefaultScopeOpen(false)}
        />
      )}
    </section>
  )
}
