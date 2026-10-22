import { useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { HeuristicTaskAnalyzer, MAX_TASK_ANALYSIS_PROMPT_LENGTH } from '../task-analysis/HeuristicTaskAnalyzer'
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
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const formatRange = (range: { min: number; max: number }) => `${range.min.toLocaleString()}–${range.max.toLocaleString()}`

const toFileMetadata = (file: File): TaskAnalysisFile => ({
  name: file.name,
  type: file.type,
  size: file.size,
})

export function TaskAnalysisPanel({ analyzer, initialPrompt = '', initialFiles = [], onClose }: TaskAnalysisPanelProps) {
  const [prompt, setPrompt] = useState(initialPrompt)
  const [files, setFiles] = useState<TaskAnalysisFile[]>(initialFiles)
  const [result, setResult] = useState<TaskAnalysisResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const analysisRequestId = useRef(0)

  const invalidateAnalysis = () => {
    analysisRequestId.current += 1
    setResult(null)
    setError(null)
    setIsAnalyzing(false)
  }

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(event.currentTarget.files ?? []).map(toFileMetadata)
    invalidateAnalysis()
    setFiles((current) => {
      const combined = [...current, ...selectedFiles]
      return combined.filter((file, index) => combined.findIndex((candidate) => fileKey(candidate) === fileKey(file)) === index)
    })
    event.currentTarget.value = ''
  }

  const removeFile = (fileToRemove: TaskAnalysisFile) => {
    invalidateAnalysis()
    setFiles((current) => current.filter((file) => fileKey(file) !== fileKey(fileToRemove)))
  }

  const handleAnalyze = async () => {
    const requestId = analysisRequestId.current + 1
    analysisRequestId.current = requestId
    setError(null)
    setResult(null)
    setIsAnalyzing(true)

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

        <button type="button" onClick={handleAnalyze} disabled={isAnalyzing}>
          {isAnalyzing ? '分析中…' : '开始分析'}
        </button>
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
            <h3>优化后的 Prompt</h3>
            <pre className="task-analysis-optimized-prompt">{result.optimizedPrompt}</pre>
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
