import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import type { BrainProvider } from '../orchestration/BrainProvider'
import { DeepSeekBrainProvider } from '../orchestration/DeepSeekBrainProvider'
import { LocalBrainProvider } from '../orchestration/LocalBrainProvider'
import { DEFAULT_PROVIDER_PROFILES } from '../orchestration/providerProfiles'
import { createPlanWithTaskBrain } from '../orchestration/taskBrainPlanning'
import {
  readTaskBrainPreference,
  writeTaskBrainPreference,
} from '../orchestration/taskBrainPreference'
import { TASK_BRAIN_PROFILES } from '../orchestration/taskBrainProfiles'
import {
  LocalTaskSessionStore,
  type TaskSessionStore,
} from '../orchestration/TaskSessionStore'
import {
  LocalTaskCoordinationStore,
  type TaskCoordinationStore,
} from '../orchestration/TaskCoordinationStore'
import {
  LocalTaskAcceptanceStore,
  type TaskAcceptanceStore,
} from '../orchestration/TaskAcceptanceStore'
import { requestTaskEvaluation } from '../orchestration/taskEvaluationWorkflow'
import {
  createIdleTaskCoordinationSnapshot,
  createTaskCoordinationController,
  type TaskCoordinationController,
  type TaskCoordinationControllerSnapshot,
} from '../orchestration/TaskCoordinationController'
import {
  MapExecutionAdapterRegistry,
  type ExecutionAdapterRegistry,
} from '../orchestration/taskCoordinator'
import { createTaskSession, recoverInterruptedTaskExecutions } from '../orchestration/taskSession'
import { HeuristicTaskAnalyzer, MAX_TASK_ANALYSIS_PROMPT_LENGTH } from '../task-analysis/HeuristicTaskAnalyzer'
import { createDefaultPromptOptimizer } from '../task-analysis/RemotePromptOptimizer'
import {
  MAX_TASK_ANALYSIS_FILES,
  MAX_TASK_ANALYSIS_FILE_SIZE,
  MAX_TASK_ANALYSIS_TOTAL_SIZE,
  mergeTaskAnalysisFiles,
} from '../task-analysis/fileSelection'
import type {
  TaskAnalysisFile,
  TaskAnalysisResult,
  TaskAnalyzer,
} from '../types/taskAnalysis'
import type {
  AcceptancePolicy,
  TaskAcceptanceStateV1,
  TaskEvaluationAdapter,
} from '../types/taskCoordination'
import type {
  BrainPlanningErrorCode,
  ProviderProfile,
  TaskBrainId,
  TaskSessionV1,
} from '../types/taskOrchestration'
import { copyText } from '../utils/copyText'
import { TaskPlanCards } from './TaskPlanCards'
import {
  describeCodexEnvironment,
  type CodexEnvironmentState,
} from '../codex/codexEnvironment'
import {
  MINIMUM_CODEX_VERSION,
  type CodexEnvironmentResult,
} from '../../electron/codexEnvironmentProtocol'
import { describeChatGptAuth, type ChatGptAuthState } from '../codex/chatGptAuth'

export interface TaskAnalysisPanelProps {
  deliveryOwner?: string
  analyzer?: TaskAnalyzer
  initialPrompt?: string
  initialFiles?: TaskAnalysisFile[]
  brainProvider?: BrainProvider
  providers?: ProviderProfile[]
  sessionStore?: TaskSessionStore
  coordinationAdapters?: ExecutionAdapterRegistry
  coordinationStore?: TaskCoordinationStore
  evaluationAdapter?: TaskEvaluationAdapter
  acceptanceStore?: TaskAcceptanceStore
  acceptancePolicy?: AcceptancePolicy
  codexExecutionScope?: { scopeId: string; fresh: boolean }
  onClose?: () => void
}

const defaultAnalyzer = new HeuristicTaskAnalyzer(createDefaultPromptOptimizer())
const defaultLocalBrainProvider = new LocalBrainProvider()
const defaultDeepSeekBrainProvider = new DeepSeekBrainProvider()
const defaultSessionStore = new LocalTaskSessionStore()
const defaultCoordinationStore = new LocalTaskCoordinationStore()
const defaultCoordinationAdapters = new MapExecutionAdapterRegistry()
const defaultAcceptanceStore = new LocalTaskAcceptanceStore()
const defaultAcceptancePolicy: AcceptancePolicy = {
  mode: 'manual',
  trustedMethods: [],
  maxAttempts: 3,
}

const brainFallbackLabels: Partial<Record<BrainPlanningErrorCode, string>> = {
  NOT_CONFIGURED: 'DeepSeek 任务规划尚未接入，已安全回退到本地规则。',
  RATE_LIMITED: 'DeepSeek 任务规划请求受限，已安全回退到本地规则。',
  UNAVAILABLE: 'DeepSeek 任务规划当前不可用，已安全回退到本地规则。',
  TIMEOUT: 'DeepSeek 任务规划响应超时，已安全回退到本地规则。',
  INVALID_RESPONSE: 'DeepSeek 返回的任务方案无效，已安全回退到本地规则。',
  FAILED: 'DeepSeek 任务规划失败，已安全回退到本地规则。',
}

const errorLabels: Record<'EMPTY_INPUT' | 'INPUT_TOO_LARGE' | 'INVALID_FILE' | 'ANALYSIS_FAILED', string> = {
  EMPTY_INPUT: '缺少分析输入',
  INPUT_TOO_LARGE: 'Prompt 超出长度限制',
  INVALID_FILE: '文件信息无效',
  ANALYSIS_FAILED: '分析失败',
}

const fileKey = (file: TaskAnalysisFile) => `${file.name}\u0000${file.type}\u0000${file.size}`

const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

const formatRange = (range: { min: number; max: number }) => `${range.min.toLocaleString()}–${range.max.toLocaleString()}`

const toFileMetadata = (file: File): TaskAnalysisFile => ({
  name: file.name,
  type: file.type,
  size: file.size,
})

export function TaskAnalysisPanel({
  deliveryOwner,
  analyzer,
  initialPrompt = '',
  initialFiles = [],
  brainProvider,
  providers = DEFAULT_PROVIDER_PROFILES,
  sessionStore = defaultSessionStore,
  coordinationAdapters = defaultCoordinationAdapters,
  coordinationStore = defaultCoordinationStore,
  evaluationAdapter,
  acceptanceStore = defaultAcceptanceStore,
  acceptancePolicy = defaultAcceptancePolicy,
  onClose,
}: TaskAnalysisPanelProps) {
  const initialFileSelection = mergeTaskAnalysisFiles([], initialFiles)
  const [prompt, setPrompt] = useState(initialPrompt)
  const [files, setFiles] = useState<TaskAnalysisFile[]>(() => initialFileSelection.files)
  const [fileNotice, setFileNotice] = useState<string | null>(() => initialFileSelection.notice)
  const [result, setResult] = useState<TaskAnalysisResult | null>(null)
  const [taskSession, setTaskSession] = useState<TaskSessionV1 | null>(null)
  const [coordinationSnapshot, setCoordinationSnapshot] = useState<TaskCoordinationControllerSnapshot>(
    createIdleTaskCoordinationSnapshot,
  )
  const [acceptanceState, setAcceptanceState] = useState<TaskAcceptanceStateV1 | null>(null)
  const [acceptanceNotice, setAcceptanceNotice] = useState<string | null>(null)
  const [acceptanceBlocked, setAcceptanceBlocked] = useState(false)
  const [evaluatingTaskId, setEvaluatingTaskId] = useState<string | null>(null)
  const [evaluationError, setEvaluationError] = useState<{ taskId: string; message: string } | null>(null)
  const [completedSession, setCompletedSession] = useState<TaskSessionV1 | null>(null)
  const [planError, setPlanError] = useState<string | null>(null)
  const [storageNotice, setStorageNotice] = useState<string | null>(null)
  const [storageBlocked, setStorageBlocked] = useState(false)
  const [coordinationEvidenceBlocked, setCoordinationEvidenceBlocked] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [copyStatus, setCopyStatus] = useState<'idle' | 'success' | 'error'>('idle')
  const [clearArmed, setClearArmed] = useState(false)
  const [selectedBrainId, setSelectedBrainId] = useState<TaskBrainId>(() => (
    brainProvider?.profile.id ?? readTaskBrainPreference()
  ))
  const [analysisDetailsOpen, setAnalysisDetailsOpen] = useState(true)
  const [codexSetupOpen, setCodexSetupOpen] = useState(false)
  const [attachmentsOpen, setAttachmentsOpen] = useState(initialFiles.length > 0)
  const analysisRequestId = useRef(0)
  const planningController = useRef<AbortController | null>(null)
  const coordinationController = useRef<TaskCoordinationController | null>(null)
  const evaluationController = useRef<{ taskId: string; sessionId: string; controller: AbortController } | null>(null)
  const acceptanceLoadId = useRef(0)
  const restoreRequestId = useRef(0)
  const codexEnvironmentRequest = useRef<string | null>(null)
  const chatGptSignInRequest = useRef<string | null>(null)
  const [chatGptAuth, setChatGptAuth] = useState<ChatGptAuthState>(() => (
    window.petcast?.readChatGptSession ? { status: 'loading' } : { status: 'browser' }
  ))
  const [codexEnvironment, setCodexEnvironment] = useState<CodexEnvironmentState>(() => (
    window.petcast?.checkCodexEnvironment ? { status: 'checking' } : { status: 'browser' }
  ))

  const checkCodex = useCallback(async () => {
    if (!window.petcast?.checkCodexEnvironment) {
      setCodexEnvironment({ status: 'browser' })
      return
    }
    const previous = codexEnvironmentRequest.current
    if (previous) window.petcast.cancelCodexEnvironment(previous)
    const requestId = `environment-${globalThis.crypto.randomUUID()}`
    codexEnvironmentRequest.current = requestId
    setCodexEnvironment({ status: 'checking' })
    try {
      const result = await window.petcast.checkCodexEnvironment(requestId)
      if (codexEnvironmentRequest.current !== requestId) return
      setCodexEnvironment(result.ok ? { status: 'ready', result } : { status: 'error', result })
    } catch {
      if (codexEnvironmentRequest.current !== requestId) return
      const result: Extract<CodexEnvironmentResult, { ok: false }> = {
        ok: false,
        code: 'UNAVAILABLE',
        checkedAt: new Date().toISOString(),
        minimumVersion: MINIMUM_CODEX_VERSION,
      }
      setCodexEnvironment({ status: 'error', result })
    } finally {
      if (codexEnvironmentRequest.current === requestId) codexEnvironmentRequest.current = null
    }
  }, [])

  const readChatGptSession = useCallback(async () => {
    if (!window.petcast?.readChatGptSession) {
      setChatGptAuth({ status: 'browser' })
      return
    }
    setChatGptAuth({ status: 'loading' })
    try { setChatGptAuth({ status: 'result', result: await window.petcast.readChatGptSession() }) }
    catch {
      setChatGptAuth({ status: 'result', result: {
        ok: false,
        code: 'UNAVAILABLE',
        checkedAt: new Date().toISOString(),
      } })
    }
  }, [])

  const signInWithChatGpt = useCallback(async () => {
    if (!window.petcast?.signInWithChatGpt || chatGptSignInRequest.current) return
    setCodexSetupOpen(true)
    const requestId = `chatgpt-${globalThis.crypto.randomUUID()}`
    chatGptSignInRequest.current = requestId
    setChatGptAuth({ status: 'connecting' })
    try {
      const result = await window.petcast.signInWithChatGpt(requestId)
      if (chatGptSignInRequest.current !== requestId) return
      setChatGptAuth({ status: 'result', result })
      await checkCodex()
    } catch {
      if (chatGptSignInRequest.current === requestId) setChatGptAuth({ status: 'result', result: {
        ok: false,
        code: 'UNAVAILABLE',
        checkedAt: new Date().toISOString(),
      } })
    } finally {
      if (chatGptSignInRequest.current === requestId) chatGptSignInRequest.current = null
    }
  }, [checkCodex])

  const signOutChatGpt = useCallback(async () => {
    if (!window.petcast?.signOutChatGpt) return
    setCodexSetupOpen(true)
    setChatGptAuth({ status: 'signing-out' })
    try { setChatGptAuth({ status: 'result', result: await window.petcast.signOutChatGpt() }) }
    catch { setChatGptAuth({ status: 'result', result: { ok: false, code: 'UNAVAILABLE', checkedAt: new Date().toISOString() } }) }
    await checkCodex()
  }, [checkCodex])

  useEffect(() => {
    void readChatGptSession().then(checkCodex)
    return () => {
      planningController.current?.abort()
      planningController.current = null
      evaluationController.current?.controller.abort()
      evaluationController.current = null
      const authRequestId = chatGptSignInRequest.current
      chatGptSignInRequest.current = null
      if (authRequestId) window.petcast?.cancelChatGptSignIn?.(authRequestId)
      const requestId = codexEnvironmentRequest.current
      codexEnvironmentRequest.current = null
      if (requestId) window.petcast?.cancelCodexEnvironment?.(requestId)
    }
  }, [checkCodex, readChatGptSession])

  const persistSession = async (session: TaskSessionV1) => {
    const outcome = await sessionStore.save(session)
    if (!outcome.ok) setStorageNotice(outcome.message)
    else setStorageNotice(null)
  }

  const showSession = (session: TaskSessionV1) => {
    setPrompt(session.analysisInput.prompt)
    setFiles(session.analysisInput.files)
    setResult(session.analysisResult)
    setTaskSession(session)
    setCompletedSession(null)
    setPlanError(null)
    setError(null)
    setAnalysisDetailsOpen(false)
    setSelectedBrainId(session.plan.planningBrain?.requestedBrainId ?? 'local')
  }

  useEffect(() => {
    if (initialPrompt.length > 0 || initialFiles.length > 0) return
    const requestId = restoreRequestId.current + 1
    restoreRequestId.current = requestId
    let active = true
    void sessionStore.loadLatest().then((outcome) => {
      if (!active || requestId !== restoreRequestId.current) return
      if (!outcome.ok) {
        setStorageNotice(`${outcome.message}（${outcome.code}）`)
        setStorageBlocked(outcome.code === 'CORRUPT_DATA' || outcome.code === 'LIMIT_EXCEEDED')
        return
      }
      if (!outcome.session) return
      const restored = recoverInterruptedTaskExecutions(outcome.session)
      if (restored !== outcome.session) void persistSession(restored)
      if (restored.completedAt) setCompletedSession(restored)
      else showSession(restored)
    })
    return () => { active = false }
  }, [sessionStore])

  useEffect(() => {
    if (!taskSession) return
    const timer = window.setTimeout(() => { void persistSession(taskSession) }, 300)
    return () => window.clearTimeout(timer)
  }, [taskSession, sessionStore])

  useEffect(() => {
    coordinationController.current?.dispose()
    coordinationController.current = null
    setCoordinationSnapshot(createIdleTaskCoordinationSnapshot())
    if (!taskSession) return
    const controller = createTaskCoordinationController({
      session: taskSession,
      coordinationStore,
      sessionStore,
      adapters: coordinationAdapters,
      onSessionChange: setTaskSession,
    })
    coordinationController.current = controller
    const unsubscribe = controller.subscribe(setCoordinationSnapshot)
    return () => {
      unsubscribe()
      controller.dispose()
      if (coordinationController.current === controller) coordinationController.current = null
    }
  }, [taskSession?.id, coordinationAdapters, coordinationStore, sessionStore])

  useEffect(() => {
    const requestId = acceptanceLoadId.current + 1
    acceptanceLoadId.current = requestId
    setAcceptanceState(null)
    setAcceptanceNotice(null)
    setAcceptanceBlocked(false)
    setEvaluationError(null)
    if (!taskSession) return
    let active = true
    void acceptanceStore.load({
      sessionId: taskSession.id,
      planId: taskSession.plan.id,
      taskIds: taskSession.plan.tasks.map(task => task.id),
    }).then((outcome) => {
      if (!active || requestId !== acceptanceLoadId.current) return
      if (outcome.ok) {
        setAcceptanceState(outcome.state)
        return
      }
      setAcceptanceBlocked(true)
      setAcceptanceNotice(`${outcome.message}（${outcome.code}）`)
    })
    return () => { active = false }
  }, [taskSession?.id, acceptanceStore])

  useEffect(() => {
    const pending = evaluationController.current
    if (!pending) return
    const run = taskSession?.id === pending.sessionId
      ? taskSession.runs.find(item => item.taskId === pending.taskId)
      : undefined
    if (run?.status === 'review') return
    pending.controller.abort()
    evaluationController.current = null
    setEvaluatingTaskId(null)
  }, [taskSession])

  useEffect(() => {
    if (taskSession) coordinationController.current?.updateSession(taskSession)
  }, [taskSession])

  useEffect(() => {
    let active = true
    setCoordinationEvidenceBlocked(true)
    void coordinationStore.load({}).then((loaded) => {
      if (!active) return
      const finished = Boolean((taskSession ?? completedSession)?.completedAt)
      setCoordinationEvidenceBlocked(!loaded.ok || Boolean(!finished && loaded.state?.records.some(record => !record.resolution)))
    }).catch(() => { if (active) setCoordinationEvidenceBlocked(true) })
    return () => { active = false }
  }, [coordinationStore, taskSession?.id, completedSession?.id, taskSession?.completedAt, coordinationSnapshot.records])

  const clearInactiveCoordination = async () => {
    let loaded
    try { loaded = await coordinationStore.load({}) }
    catch { setStorageNotice('无法核对协调记录，已保留任务与执行证据。'); return false }
    if (!loaded.ok) {
      setStorageNotice(`${loaded.message} 请先核对协调记录，当前任务未清空。`)
      return false
    }
    const finished = Boolean((taskSession ?? completedSession)?.completedAt)
    if (!finished && loaded.state?.records.some(record => !record.resolution)) {
      setStorageNotice('存在尚未处理的协调执行证据。请先核对外部执行并处理任务，当前任务未清空。')
      setCoordinationEvidenceBlocked(true)
      return false
    }
    const cleared = await coordinationStore.clear()
    if (!cleared.ok) { setStorageNotice(cleared.message); return false }
    setCoordinationEvidenceBlocked(false)
    return true
  }

  const handleSessionChange = (session: TaskSessionV1, persistImmediately = false) => {
    setTaskSession(session)
    if (persistImmediately) void persistSession(session)
  }

  const handleRequestEvaluation = async (taskId: string, evidence?: import('../types/taskCoordination').EvaluationEvidenceRef[]) => {
    if (!taskSession || acceptanceBlocked || evaluationController.current) return
    const controller = new AbortController()
    const sessionId = taskSession.id
    evaluationController.current = { taskId, sessionId, controller }
    setEvaluatingTaskId(taskId)
    setEvaluationError(null)
    const outcome = await requestTaskEvaluation({
      session: taskSession,
      taskId,
      adapter: evaluationAdapter,
      evidence,
      coordinationStore,
      acceptanceStore,
      policy: acceptancePolicy,
      signal: controller.signal,
    })
    const current = evaluationController.current
    if (!current || current.controller !== controller || current.sessionId !== sessionId) return
    evaluationController.current = null
    setEvaluatingTaskId(null)
    if (outcome.ok) {
      setAcceptanceState(outcome.state)
      setAcceptanceNotice(outcome.reused ? '已加载当前派发的既有评价，没有再次调用 D 评价器。' : null)
    } else if (outcome.code !== 'CANCELLED') {
      setEvaluationError({ taskId, message: `${outcome.message}（${outcome.code}）` })
    }
  }

  const handleCancelEvaluation = (taskId: string) => {
    const pending = evaluationController.current
    if (!pending || pending.taskId !== taskId) return
    pending.controller.abort()
    evaluationController.current = null
    setEvaluatingTaskId(null)
  }

  const clearAcceptanceState = async () => {
    const outcome = await acceptanceStore.clear()
    if (!outcome.ok) {
      setAcceptanceNotice(outcome.message)
      return
    }
    setAcceptanceState(null)
    setAcceptanceNotice(null)
    setAcceptanceBlocked(false)
    setEvaluationError(null)
  }

  const invalidateAnalysis = () => {
    analysisRequestId.current += 1
    planningController.current?.abort()
    planningController.current = null
    setResult(null)
    setTaskSession(null)
    setCompletedSession(null)
    setPlanError(null)
    setError(null)
    setIsAnalyzing(false)
    setCopyStatus('idle')
    setClearArmed(false)
    setAnalysisDetailsOpen(true)
    coordinationController.current?.dispose()
    coordinationController.current = null
    evaluationController.current?.controller.abort()
    evaluationController.current = null
    setAcceptanceState(null)
    setEvaluatingTaskId(null)
    setEvaluationError(null)
    if (!acceptanceBlocked) {
      setAcceptanceNotice(null)
      void acceptanceStore.clear()
    }
    void sessionStore.clear().then((outcome) => {
      if (!outcome.ok) setStorageNotice(outcome.message)
      else {
        setStorageNotice(null)
        setStorageBlocked(false)
      }
    })
  }

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget
    const selectedFiles = Array.from(input.files ?? []).map(toFileMetadata)
    const selection = mergeTaskAnalysisFiles(files, selectedFiles)
    input.value = ''
    if (coordinationEvidenceBlocked) return
    if (selection.addedCount > 0) invalidateAnalysis()
    setFiles(selection.files)
    setFileNotice(selection.notice)
  }

  const removeFile = (fileToRemove: TaskAnalysisFile) => {
    if (coordinationEvidenceBlocked) return
    invalidateAnalysis()
    setFiles((current) => current.filter((file) => fileKey(file) !== fileKey(fileToRemove)))
    setFileNotice(null)
  }

  const handleAnalyze = async () => {
    if (acceptanceBlocked) {
      setAcceptanceNotice('请先明确清除损坏的评价记录，再开始新的分析。')
      return
    }
    if (!await clearInactiveCoordination()) return

    const requestId = analysisRequestId.current + 1
    analysisRequestId.current = requestId
    setError(null)
    setResult(null)
    setTaskSession(null)
    setCompletedSession(null)
    setPlanError(null)
    setIsAnalyzing(true)
    setCopyStatus('idle')
    setClearArmed(false)
    setAnalysisDetailsOpen(true)
    coordinationController.current?.dispose()
    coordinationController.current = null
    evaluationController.current?.controller.abort()
    evaluationController.current = null
    setAcceptanceState(null)
    setAcceptanceNotice(null)
    setAcceptanceBlocked(false)
    setEvaluatingTaskId(null)
    setEvaluationError(null)
    void acceptanceStore.clear()
    void sessionStore.clear().then((outcome) => {
      if (!outcome.ok) setStorageNotice(outcome.message)
      else {
        setStorageNotice(null)
        setStorageBlocked(false)
      }
    })

    try {
      const outcome = await (analyzer ?? defaultAnalyzer).analyze({ prompt, files })
      if (requestId !== analysisRequestId.current) return
      if (outcome.ok) {
        setResult(outcome.result)
        const controller = new AbortController()
        planningController.current?.abort()
        planningController.current = controller
        let planningOutcome
        try {
          const requestedBrainId = brainProvider?.profile.id ?? selectedBrainId
          planningOutcome = await createPlanWithTaskBrain(
            requestedBrainId,
            {
              analysisInput: { prompt, files },
              analysisResult: outcome.result,
              availableProviders: providers,
            },
            {
              local: brainProvider?.profile.id === 'local' ? brainProvider : defaultLocalBrainProvider,
              deepseek: brainProvider?.profile.id === 'deepseek' ? brainProvider : defaultDeepSeekBrainProvider,
            },
            controller.signal,
          )
        } catch {
          if (requestId === analysisRequestId.current && !controller.signal.aborted) {
            setPlanError('任务拆解请求失败，请稍后重试。')
          }
          return
        }
        if (requestId !== analysisRequestId.current || controller.signal.aborted) return
        if (planningOutcome.ok) {
          const sessionOutcome = createTaskSession({
            analysisInput: { prompt, files },
            analysisResult: outcome.result,
            plan: planningOutcome.plan,
          })
          if (sessionOutcome.ok) {
            setTaskSession(sessionOutcome.session)
            setAnalysisDetailsOpen(false)
            void persistSession(sessionOutcome.session)
          } else {
            setPlanError(`${sessionOutcome.message}（${sessionOutcome.code}）`)
          }
        } else {
          setPlanError(`${planningOutcome.message}（${planningOutcome.code}）`)
        }
      } else {
        setError(`${errorLabels[outcome.code]}：${outcome.message}（${outcome.code}）`)
      }
    } catch {
      if (requestId !== analysisRequestId.current) return
      setError('分析请求失败，请稍后重试。')
    } finally {
      if (requestId === analysisRequestId.current) {
        planningController.current = null
        setIsAnalyzing(false)
      }
    }
  }

  const handleCopyPrompt = async () => {
    if (!result) return
    setCopyStatus(await copyText(result.optimizedPrompt) ? 'success' : 'error')
  }

  const handleClear = async () => {
    if (!clearArmed) {
      setClearArmed(true)
      return
    }
    if (!await clearInactiveCoordination()) {
      setClearArmed(false)
      return
    }

    analysisRequestId.current += 1
    planningController.current?.abort()
    planningController.current = null
    setPrompt('')
    setFiles([])
    setFileNotice(null)
    setResult(null)
    setTaskSession(null)
    setCompletedSession(null)
    setPlanError(null)
    setError(null)
    setIsAnalyzing(false)
    setCopyStatus('idle')
    setClearArmed(false)
    setAnalysisDetailsOpen(true)
    coordinationController.current?.dispose()
    coordinationController.current = null
    evaluationController.current?.controller.abort()
    evaluationController.current = null
    setAcceptanceState(null)
    setAcceptanceNotice(null)
    setAcceptanceBlocked(false)
    setEvaluatingTaskId(null)
    setEvaluationError(null)
    void acceptanceStore.clear()
    void sessionStore.clear().then((outcome) => {
      setStorageNotice(outcome.ok ? null : outcome.message)
      if (outcome.ok) setStorageBlocked(false)
    })
  }

  const canClear = prompt.length > 0
    || files.length > 0
    || Boolean(result)
    || Boolean(taskSession)
    || Boolean(completedSession)
    || Boolean(planError)
    || Boolean(error)
    || Boolean(fileNotice)
    || isAnalyzing

  const sessionStarted = Boolean(taskSession?.runs.some(run => run.attempt > 0 || !['waiting', 'ready'].includes(run.status)))
  const sessionLocked = sessionStarted || Boolean(completedSession) || storageBlocked || coordinationEvidenceBlocked
  const completedTaskCount = taskSession?.runs.filter(run => run.status === 'done').length ?? 0
  const planningBrain = taskSession?.plan.planningBrain
  const requestedBrainName = planningBrain
    ? TASK_BRAIN_PROFILES[planningBrain.requestedBrainId].displayName
    : '本地规则'
  const actualBrainName = planningBrain
    ? TASK_BRAIN_PROFILES[planningBrain.actualBrainId].displayName
    : '本地规则（旧会话）'
  const planningBrainSummary = planningBrain?.requestedBrainId !== planningBrain?.actualBrainId
    ? `计划选择：${requestedBrainName} · 实际使用：${actualBrainName}`
    : `任务拆解大脑：${actualBrainName}`
  const planningBrainFallback = planningBrain?.fallbackCode
    ? brainFallbackLabels[planningBrain.fallbackCode]
    : undefined
  const codexEnvironmentPresentation = describeCodexEnvironment(codexEnvironment)
  const chatGptAuthPresentation = describeChatGptAuth(chatGptAuth)
  const codexSetupChecking = ['loading', 'connecting', 'signing-out'].includes(chatGptAuth.status)
    || codexEnvironment.status === 'checking'
  const codexSetupReady = chatGptAuthPresentation.connected && codexEnvironment.status === 'ready'
  const codexSetupLabel = codexSetupChecking
    ? '检查中'
    : codexSetupReady
      ? '已就绪'
      : chatGptAuth.status === 'browser' || codexEnvironment.status === 'browser'
        ? '仅桌面版可用'
        : '未连接，人工模式可用'
  const codexSetupTone = codexSetupReady ? 'ready' : codexSetupChecking ? 'checking' : 'warning'

  useEffect(() => {
    if (error || planError) setAnalysisDetailsOpen(true)
  }, [error, planError])

  useEffect(() => {
    if (fileNotice || files.length > 0) setAttachmentsOpen(true)
  }, [fileNotice, files.length])

  return (
    <section
      className="task-analysis-panel"
      aria-labelledby="task-analysis-title"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <header className="task-analysis-header">
        <h2 id="task-analysis-title">任务分析</h2>
      </header>

      {onClose && (
        <button type="button" className="task-analysis-close" onClick={() => {
          evaluationController.current?.controller.abort()
          evaluationController.current = null
          onClose()
        }} aria-label="关闭任务分析">×</button>
      )}



      {completedSession && !taskSession && (
        <div className="task-session-restore" role="status">
          <strong>发现最近已完成的任务报告</strong>
          <span>{completedSession.plan.title}</span>
          <button type="button" onClick={() => showSession(completedSession)}>查看上次报告</button>
          <button type="button" onClick={handleClear}>{clearArmed ? '再次点击确认新建' : '新建任务'}</button>
        </div>
      )}

      {storageNotice && (
        <div className="task-storage-notice" role="alert">
          <span>{storageNotice}</span>
          <button type="button" onClick={() => void clearInactiveCoordination().then((allowed) => {
            if (!allowed) return null
            return sessionStore.clear()
          }).then((outcome) => {
            if (!outcome) return
            if (outcome.ok) {
              setStorageNotice(null)
              setStorageBlocked(false)
            }
          })}>清除本地记录</button>
        </div>
      )}

      {acceptanceNotice && (
        <div className="task-storage-notice" role={acceptanceBlocked ? 'alert' : 'status'}>
          <span>{acceptanceNotice}</span>
          {acceptanceBlocked && <button type="button" onClick={() => void clearAcceptanceState()}>清除评价记录</button>}
        </div>
      )}

      {result && taskSession && (
        <section className="task-analysis-overview" aria-label="任务分析摘要">
          <div>
            <strong>{taskSession.plan.title}</strong>
            <div className="task-overview-meta">
              <span>{completedTaskCount}/{taskSession.runs.length} 已完成 · {planningBrainSummary}</span>
              <span className={`task-analysis-optimization-source is-${result.promptOptimizationSource}`}>
                Prompt 优化：{result.promptOptimizationSource === 'deepseek' ? 'DeepSeek' : '本地规则'}
              </span>
            </div>
            {planningBrainFallback && <p className="task-brain-fallback" role="status">{planningBrainFallback}</p>}
          </div>
          <button
            type="button"
            aria-expanded={analysisDetailsOpen}
            aria-controls="task-analysis-details"
            onClick={() => setAnalysisDetailsOpen(open => !open)}
          >
            {analysisDetailsOpen ? '收起输入与分析' : '查看输入与完整分析'}
          </button>
        </section>
      )}

      <div id="task-analysis-details" hidden={Boolean(result && taskSession) && !analysisDetailsOpen}>
      <div className="task-analysis-inputs">
        <div className="task-input-heading">
          <label htmlFor="task-analysis-prompt">任务描述</label>
          <p id="task-analysis-prompt-hint" className="task-analysis-input-hint">
            {prompt.length.toLocaleString()} / {MAX_TASK_ANALYSIS_PROMPT_LENGTH.toLocaleString()} 字符
          </p>
        </div>
        <textarea
          id="task-analysis-prompt"
          value={prompt}
          disabled={sessionLocked}
          onChange={(event) => {
            if (coordinationEvidenceBlocked) return
            invalidateAnalysis()
            setPrompt(event.target.value)
          }}
          placeholder="描述需要完成的任务、约束和期望输出……"
          rows={3}
          aria-describedby="task-analysis-prompt-hint"
        />
        <details className="task-analysis-attachments" open={attachmentsOpen} onToggle={event => setAttachmentsOpen(event.currentTarget.open)}>
          <summary>相关文件（可选）<span>{files.length ? `已添加 ${files.length} 个` : '仅使用文件名、类型和大小'}</span></summary>
          <div className="task-attachment-content">
        <label htmlFor="task-analysis-files">选择相关文件</label>
        <input id="task-analysis-files" type="file" multiple disabled={sessionLocked} onChange={handleFileChange} />
        {sessionStarted && <p className="task-analysis-input-hint">任务已经开始，输入已锁定；新建任务需要二次确认。</p>}
        <p className="task-analysis-file-limits">
          最多 {MAX_TASK_ANALYSIS_FILES} 个文件；单个不超过 {formatBytes(MAX_TASK_ANALYSIS_FILE_SIZE)}；总计不超过 {formatBytes(MAX_TASK_ANALYSIS_TOTAL_SIZE)}。
        </p>
        {fileNotice && (
          <p className="task-analysis-file-notice" role="status">{fileNotice}</p>
        )}
        {files.length > 0 ? (
          <ul className="task-analysis-file-list" aria-label="已选择文件">
            {files.map((file) => (
              <li key={fileKey(file)}>
                <span>
                  <strong>{file.name}</strong>
                  <small>{file.type} · {formatBytes(file.size)}</small>
                </span>
                <button type="button" disabled={sessionLocked} onClick={() => removeFile(file)} aria-label={`移除 ${file.name}`}>移除</button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="task-analysis-empty-files">尚未添加文件；可以只分析 Prompt。</p>
        )}
          </div>
        </details>

        <div className="task-brain-selector">
          <label htmlFor="task-planning-brain">任务拆解大脑</label>
          <select
            id="task-planning-brain"
            value={brainProvider?.profile.id ?? selectedBrainId}
            disabled={sessionLocked || isAnalyzing || Boolean(brainProvider)}
            onChange={(event) => {
              const value = event.target.value as TaskBrainId
              setSelectedBrainId(value)
              writeTaskBrainPreference(value)
            }}
          >
            <option value="local">本地规则（默认）</option>
            <option value="deepseek">DeepSeek</option>
          </select>
          {brainProvider ? (
            <p role="status">当前任务拆解大脑由调用方指定为 {brainProvider.profile.displayName}。</p>
          ) : selectedBrainId === 'deepseek' ? (
            <p role="status">分析时会把 Prompt、本地分析结果和附件元信息发送到团队服务；不会上传附件内容、工作区路径、账号或额度。服务不可用时自动回退本地规则。</p>
          ) : (
            <p>本地规则不会联网，也不会产生模型调用费用。</p>
          )}
        </div>

        <div className="task-analysis-actions">
          <button
            type="button"
            onClick={handleAnalyze}
            disabled={isAnalyzing || sessionLocked || acceptanceBlocked}
          >
            {isAnalyzing ? '分析并拆解中…' : '开始分析'}
          </button>
          <button
            type="button"
            className={clearArmed ? 'task-analysis-clear is-armed' : 'task-analysis-clear'}
            onClick={handleClear}
            disabled={!canClear}
            aria-pressed={clearArmed}
          >
            {clearArmed ? '再次点击确认清空' : sessionStarted ? '新建任务' : '清空输入'}
          </button>
        </div>
        <p className="task-analysis-privacy">启用 AI 优化或 DeepSeek 大脑时只发送任务描述、分析结果和文件元信息，不读取或上传文件内容。</p>
      </div>

      {error && (
        <p className="task-analysis-error" role="alert">{error}</p>
      )}

      {result && (
        <article className="task-analysis-result" aria-live="polite">
          <header>
            <h2>分析结果</h2>
          </header>

          <dl className="task-analysis-summary">
            <div><dt>任务类型</dt><dd>{result.taskType}</dd></div>
            <div><dt>复杂度</dt><dd>{result.complexity}</dd></div>
            <div><dt>预计输入 Token</dt><dd>{formatRange(result.estimatedInputTokens)}</dd></div>
            <div><dt>预计输出 Token</dt><dd>{formatRange(result.estimatedOutputTokens)}</dd></div>
          </dl>

          <p className="task-analysis-basis">估算依据：基于 Prompt 和文件元信息的粗估（{result.estimationBasis}）。</p>

          <section>
            <h3>估算假设</h3>
            <ul>{result.assumptions.map((assumption) => <li key={assumption}>{assumption}</li>)}</ul>
          </section>

          <section>
            <div className="task-analysis-section-heading">
              <h3>优化后的 Prompt</h3>
              <span className={`task-analysis-optimization-source is-${result.promptOptimizationSource}`}>
                {result.promptOptimizationSource === 'deepseek' ? 'DeepSeek AI 优化' : '本地规则优化'}
              </span>
              <button type="button" className="task-analysis-copy" onClick={handleCopyPrompt}>
                {copyStatus === 'success' ? '已复制' : '复制 Prompt'}
              </button>
            </div>
            <pre className="task-analysis-optimized-prompt">{result.optimizedPrompt}</pre>
            {copyStatus !== 'idle' && (
              <p
                className={`task-analysis-copy-status is-${copyStatus}`}
                role={copyStatus === 'error' ? 'alert' : 'status'}
              >
                {copyStatus === 'success' ? '优化后的 Prompt 已复制到剪贴板。' : '复制失败，请手动选择 Prompt 文本。'}
              </p>
            )}
          </section>

          <section>
            <h3>{result.canRunInParallel ? '并行建议' : '串行建议'}</h3>
            <ul>{result.parallelPlan.map((step) => <li key={step}>{step}</li>)}</ul>
          </section>

          {result.warnings.length > 0 && (
            <section className="task-analysis-warnings" role="status">
              <h3>提示</h3>
              <ul>{result.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
            </section>
          )}
        </article>
      )}

      {result && planError && (
        <p className="task-plan-error" role="alert">分析已完成，但任务拆解失败：{planError}</p>
      )}
      </div>

      <details
        className={`codex-setup-status is-${codexSetupTone}`}
        open={codexSetupOpen}
        onToggle={(event) => setCodexSetupOpen(event.currentTarget.open)}
      >
        <summary>
          <span><strong>Codex 自动执行（可选）</strong><small>不会影响人工复制与任务跟踪</small></span>
          <em role="status">{codexSetupLabel}</em>
        </summary>
        <div className="codex-setup-content">
          <section className={`chatgpt-auth-status is-${chatGptAuthPresentation.tone}`} role="status">
            <div>
              <strong>{chatGptAuthPresentation.title}</strong>
              <p>{chatGptAuthPresentation.message}</p>
              <small>PetCast 只在主进程安全保存凭据；任务页面、日志和任务存档不会收到 Token。</small>
            </div>
            <div className="chatgpt-auth-actions">
              {chatGptAuth.status === 'connecting' ? (
                <button type="button" onClick={() => {
                  const requestId = chatGptSignInRequest.current
                  if (requestId) window.petcast?.cancelChatGptSignIn?.(requestId)
                }}>取消登录</button>
              ) : chatGptAuthPresentation.connected ? <>
                <button type="button" onClick={() => void window.petcast?.openChatGptUsage?.()}>管理用量</button>
                <button type="button" onClick={() => void signOutChatGpt()}>断开连接</button>
              </> : chatGptAuth.status !== 'browser' ? (
                <button type="button" className="chatgpt-continue" onClick={() => void signInWithChatGpt()}>
                  {chatGptAuthPresentation.actionLabel}
                </button>
              ) : null}
            </div>
          </section>

          <section className={`codex-environment-status is-${codexEnvironmentPresentation.tone}`} role="status">
            <div>
              <strong>{codexEnvironmentPresentation.title}</strong>
              <p>{codexEnvironmentPresentation.message}</p>
              {codexEnvironmentPresentation.version && (
                <small>当前版本：{codexEnvironmentPresentation.version}；最低支持：{MINIMUM_CODEX_VERSION}</small>
              )}
            </div>
            {codexEnvironment.status !== 'browser' && (
              <button type="button" disabled={codexEnvironment.status === 'checking'} onClick={() => {
                setCodexSetupOpen(true)
                void checkCodex()
              }}>
                {codexEnvironment.status === 'checking' ? '检查中…' : '重新检查'}
              </button>
            )}
          </section>
        </div>
      </details>

      {result && taskSession && (
        <TaskPlanCards
          key={taskSession.id}
          session={taskSession}
          deliveryOwner={deliveryOwner}
          providers={providers}
          codexEnvironment={codexEnvironment}
          onSessionChange={handleSessionChange}
          coordinationSnapshot={coordinationSnapshot}
          coordinationAdapters={coordinationAdapters}
          acceptanceState={acceptanceState}
          evaluationAdapterAvailable={Boolean(evaluationAdapter) && !acceptanceBlocked}
          evaluatingTaskId={evaluatingTaskId}
          evaluationError={evaluationError}
          onRequestEvaluation={handleRequestEvaluation}
          onCancelEvaluation={handleCancelEvaluation}
          onCoordinationStart={() => coordinationController.current?.start() ?? Promise.resolve()}
          onCoordinationPause={() => coordinationController.current?.pause()}
          onCoordinationResume={() => coordinationController.current?.resume() ?? Promise.resolve()}
          onCoordinationRunNow={() => coordinationController.current?.runNow() ?? Promise.resolve()}
          onCoordinationInspect={() => coordinationController.current?.inspectExisting() ?? Promise.resolve()}
          onCoordinationCancelTask={(taskId) => coordinationController.current?.cancelTask(taskId) ?? Promise.resolve()}
          onCoordinationResolveTask={(taskId, dispatchId, action, riskAcknowledged) => coordinationController.current?.resolveTask(taskId, dispatchId, action, riskAcknowledged) ?? Promise.resolve()}
          onCoordinationClear={() => coordinationController.current?.clearState() ?? Promise.resolve()}
        />
      )}
    </section>
  )
}
