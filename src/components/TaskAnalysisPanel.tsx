import { useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { HeuristicTaskAnalyzer, MAX_TASK_ANALYSIS_PROMPT_LENGTH } from '../task-analysis/HeuristicTaskAnalyzer'
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

export interface TaskAnalysisPanelProps {
  analyzer?: TaskAnalyzer
  initialPrompt?: string
  initialFiles?: TaskAnalysisFile[]
  onClose?: () => void
}

const defaultAnalyzer = new HeuristicTaskAnalyzer()

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

const copyText = async (text: string) => {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Fall through to the compatibility copy path.
  }

  const textarea = document.createElement('textarea')
  const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null
  textarea.value = text
  textarea.readOnly = true
  textarea.tabIndex = -1
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()

  try {
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    textarea.remove()
    activeElement?.focus()
  }
}

export function TaskAnalysisPanel({ analyzer, initialPrompt = '', initialFiles = [], onClose }: TaskAnalysisPanelProps) {
  const initialFileSelection = mergeTaskAnalysisFiles([], initialFiles)
  const [prompt, setPrompt] = useState(initialPrompt)
  const [files, setFiles] = useState<TaskAnalysisFile[]>(() => initialFileSelection.files)
  const [fileNotice, setFileNotice] = useState<string | null>(() => initialFileSelection.notice)
  const [result, setResult] = useState<TaskAnalysisResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [copyStatus, setCopyStatus] = useState<'idle' | 'success' | 'error'>('idle')
  const [clearArmed, setClearArmed] = useState(false)
  const analysisRequestId = useRef(0)

  const invalidateAnalysis = () => {
    analysisRequestId.current += 1
    setResult(null)
    setError(null)
    setIsAnalyzing(false)
    setCopyStatus('idle')
    setClearArmed(false)
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
    setIsAnalyzing(true)
    setCopyStatus('idle')
    setClearArmed(false)

    try {
      const outcome = await (analyzer ?? defaultAnalyzer).analyze({ prompt, files })
      if (requestId !== analysisRequestId.current) return
      if (outcome.ok) {
        setResult(outcome.result)
      } else {
        setError(`${errorLabels[outcome.code]}：${outcome.message}（${outcome.code}）`)
      }
    } catch {
      if (requestId !== analysisRequestId.current) return
      setError('分析请求失败，请稍后重试。')
    } finally {
      if (requestId === analysisRequestId.current) setIsAnalyzing(false)
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
    setPrompt('')
    setFiles([])
    setFileNotice(null)
    setResult(null)
    setError(null)
    setIsAnalyzing(false)
    setCopyStatus('idle')
    setClearArmed(false)
  }

  const canClear = prompt.length > 0
    || files.length > 0
    || Boolean(result)
    || Boolean(error)
    || Boolean(fileNotice)
    || isAnalyzing

  return (
    <section
      className="task-analysis-panel"
      aria-labelledby="task-analysis-title"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <header className="task-analysis-header">
        <span> TASK ANALYSIS </span>
        <h2 id="task-analysis-title">任务分析</h2>
        <p>只使用 Prompt 和文件元信息进行粗估，不会读取或上传文件内容。</p>
      </header>

      {onClose && (
        <button type="button" className="task-analysis-close" onClick={onClose} aria-label="关闭任务分析">×</button>
      )}

      <div className="task-analysis-inputs">
        <label htmlFor="task-analysis-prompt">Prompt</label>
        <textarea
          id="task-analysis-prompt"
          value={prompt}
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
        <input id="task-analysis-files" type="file" multiple onChange={handleFileChange} />
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
                <button type="button" onClick={() => removeFile(file)} aria-label={`移除 ${file.name}`}>移除</button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="task-analysis-empty-files">尚未添加文件；可以只分析 Prompt。</p>
        )}

        <div className="task-analysis-actions">
          <button type="button" onClick={handleAnalyze} disabled={isAnalyzing}>
            {isAnalyzing ? '分析中…' : '开始分析'}
          </button>
          <button
            type="button"
            className={clearArmed ? 'task-analysis-clear is-armed' : 'task-analysis-clear'}
            onClick={handleClear}
            disabled={!canClear}
            aria-pressed={clearArmed}
          >
            {clearArmed ? '再次点击确认清空' : '清空输入'}
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
    </section>
  )
}
