import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import type { BrainProvider } from '../orchestration/BrainProvider'
import { LocalBrainProvider } from '../orchestration/LocalBrainProvider'
import { DEFAULT_PROVIDER_PROFILES } from '../orchestration/providerProfiles'
import {
  LocalTaskSessionStore,
  type TaskSessionStore,
} from '../orchestration/TaskSessionStore'
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
import type { ProviderProfile, TaskSessionV1 } from '../types/taskOrchestration'
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
  analyzer?: TaskAnalyzer
  initialPrompt?: string
  initialFiles?: TaskAnalysisFile[]
  brainProvider?: BrainProvider
  providers?: ProviderProfile[]
  sessionStore?: TaskSessionStore
  codexExecutionScope?: { scopeId: string; fresh: boolean }
  onClose?: () => void
}

const defaultAnalyzer = new HeuristicTaskAnalyzer(createDefaultPromptOptimizer())
const defaultBrainProvider = new LocalBrainProvider()
const defaultSessionStore = new LocalTaskSessionStore()

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
  analyzer,
  initialPrompt = '',
  initialFiles = [],
  brainProvider,
  providers = DEFAULT_PROVIDER_PROFILES,
  sessionStore = defaultSessionStore,
  onClose,
}: TaskAnalysisPanelProps) {
  const initialFileSelection = mergeTaskAnalysisFiles([], initialFiles)
  const [prompt, setPrompt] = useState(initialPrompt)
  const [files, setFiles] = useState<TaskAnalysisFile[]>(() => initialFileSelection.files)
  const [fileNotice, setFileNotice] = useState<string | null>(() => initialFileSelection.notice)
  const [result, setResult] = useState<TaskAnalysisResult | null>(null)
  const [taskSession, setTaskSession] = useState<TaskSessionV1 | null>(null)
  const [completedSession, setCompletedSession] = useState<TaskSessionV1 | null>(null)
  const [planError, setPlanError] = useState<string | null>(null)
  const [storageNotice, setStorageNotice] = useState<string | null>(null)
  const [storageBlocked, setStorageBlocked] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [copyStatus, setCopyStatus] = useState<'idle' | 'success' | 'error'>('idle')
  const [clearArmed, setClearArmed] = useState(false)
  const analysisRequestId = useRef(0)
  const planningController = useRef<AbortController | null>(null)
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
    setChatGptAuth({ status: 'signing-out' })
    try { setChatGptAuth({ status: 'result', result: await window.petcast.signOutChatGpt() }) }
    catch { setChatGptAuth({ status: 'result', result: { ok: false, code: 'UNAVAILABLE', checkedAt: new Date().toISOString() } }) }
    await checkCodex()
  }, [checkCodex])

  useEffect(() => {
    void readChatGptSession().then(checkCodex)
    return () => {
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

  const handleSessionChange = (session: TaskSessionV1, persistImmediately = false) => {
    setTaskSession(session)
    if (persistImmediately) void persistSession(session)
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
    void sessionStore.clear().then((outcome) => {
      if (!outcome.ok) setStorageNotice(outcome.message)
      else {
        setStorageNotice(null)
        setStorageBlocked(false)
      }
    })
  }

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(event.currentTarget.files ?? []).map(toFileMetadata)
    const selection = mergeTaskAnalysisFiles(files, selectedFiles)
    if (selection.addedCount > 0) invalidateAnalysis()
    setFiles(selection.files)
    setFileNotice(selection.notice)
    event.currentTarget.value = ''
  }

  const removeFile = (fileToRemove: TaskAnalysisFile) => {
    invalidateAnalysis()
    setFiles((current) => current.filter((file) => fileKey(file) !== fileKey(fileToRemove)))
    setFileNotice(null)
  }

  const handleAnalyze = async () => {
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
          planningOutcome = await (brainProvider ?? defaultBrainProvider).createPlan({
            analysisInput: { prompt, files },
            analysisResult: outcome.result,
            availableProviders: providers,
          }, controller.signal)
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

  const handleClear = () => {
    if (!clearArmed) {
      setClearArmed(true)
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
  const sessionLocked = sessionStarted || Boolean(completedSession) || storageBlocked
  const codexEnvironmentPresentation = describeCodexEnvironment(codexEnvironment)
  const chatGptAuthPresentation = describeChatGptAuth(chatGptAuth)

  return (
    <section
      className="task-analysis-panel"
      aria-labelledby="task-analysis-title"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <header className="task-analysis-header">
        <span> TASK ANALYSIS </span>
        <h2 id="task-analysis-title">任务分析</h2>
        <p>启用 AI 优化时会发送 Prompt 和文件元信息；不会读取或上传文件内容。</p>
      </header>

      {onClose && (
        <button type="button" className="task-analysis-close" onClick={onClose} aria-label="关闭任务分析">×</button>
      )}

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
              Continue with ChatGPT
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
          <button type="button" disabled={codexEnvironment.status === 'checking'} onClick={() => void checkCodex()}>
            {codexEnvironment.status === 'checking' ? '检查中…' : '重新检查'}
          </button>
        )}
      </section>

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
          <button type="button" onClick={() => void sessionStore.clear().then((outcome) => {
            if (outcome.ok) {
              setStorageNotice(null)
              setStorageBlocked(false)
            }
          })}>清除本地记录</button>
        </div>
      )}

      <div className="task-analysis-inputs">
        <label htmlFor="task-analysis-prompt">Prompt</label>
        <textarea
          id="task-analysis-prompt"
          value={prompt}
          disabled={sessionLocked}
          onChange={(event) => {
            invalidateAnalysis()
            setPrompt(event.target.value)
          }}
          placeholder="描述需要完成的任务、约束和期望输出……"
          rows={7}
          aria-describedby="task-analysis-prompt-hint"
        />
        <p id="task-analysis-prompt-hint" className="task-analysis-input-hint">
          {prompt.length.toLocaleString()} / {MAX_TASK_ANALYSIS_PROMPT_LENGTH.toLocaleString()} 字符；超过上限会返回结构化错误。
        </p>

        <label htmlFor="task-analysis-files">相关文件</label>
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

        <div className="task-analysis-actions">
          <button type="button" onClick={handleAnalyze} disabled={isAnalyzing || sessionLocked}>
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
      </div>

      {error && (
        <p className="task-analysis-error" role="alert">{error}</p>
      )}

      {result && (
        <article className="task-analysis-result" aria-live="polite">
          <header>
            <span> ANALYSIS RESULT </span>
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

      {result && taskSession && (
        <TaskPlanCards
          key={taskSession.id}
          session={taskSession}
          providers={providers}
          codexEnvironment={codexEnvironment}
          onSessionChange={handleSessionChange}
        />
      )}
    </section>
  )
}
