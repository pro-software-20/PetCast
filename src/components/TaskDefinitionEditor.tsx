import { useMemo, useState } from 'react'
import type { WorkspaceSnapshot } from '../../electron/workspaceProtocol'
import {
  normalizeTaskFileScope,
  normalizeWorkspacePath,
  validateTaskPathScope,
} from '../orchestration/taskPathScope'
import { recommendTaskProvider } from '../orchestration/taskRecommendation'
import type { EditableTaskDefinition } from '../orchestration/taskSession'
import type { ProviderProfile, TaskNode } from '../types/taskOrchestration'

interface TaskDefinitionEditorProps {
  task: TaskNode
  taskType: string
  providers: ProviderProfile[]
  workspace?: WorkspaceSnapshot
  disabled: boolean
  onSave: (task: EditableTaskDefinition) => boolean
}

type ScopeKey = 'inputs' | 'allowedWritePaths' | 'forbiddenPaths' | 'outputPaths'

const lines = (value: string) => value.split(/\r?\n/).map(item => item.trim()).filter(Boolean)
const textList = (value: string[]) => value.join('\n')

const unique = (values: string[]) => [...new Set(values)]

export function TaskDefinitionEditor({
  task,
  taskType,
  providers,
  workspace,
  disabled,
  onSave,
}: TaskDefinitionEditorProps) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(task.title)
  const [description, setDescription] = useState(task.description)
  const [prompt, setPrompt] = useState(task.prompt)
  const [deliverables, setDeliverables] = useState(textList(task.expectedDeliverables))
  const [checks, setChecks] = useState(textList(task.acceptanceChecks))
  const [files, setFiles] = useState(() => structuredClone(task.files))
  const [search, setSearch] = useState('')
  const [manualOutput, setManualOutput] = useState('')
  const [errors, setErrors] = useState<string[]>([])

  const visibleEntries = useMemo(() => {
    const query = search.trim().toLocaleLowerCase()
    return (workspace?.entries ?? [])
      .filter(entry => !query || entry.path.toLocaleLowerCase().includes(query))
      .slice(0, 120)
  }, [search, workspace])

  const reset = () => {
    setTitle(task.title)
    setDescription(task.description)
    setPrompt(task.prompt)
    setDeliverables(textList(task.expectedDeliverables))
    setChecks(textList(task.acceptanceChecks))
    setFiles(structuredClone(task.files))
    setSearch('')
    setManualOutput('')
    setErrors([])
  }

  const cancel = () => {
    reset()
    setEditing(false)
  }

  const hasPath = (key: ScopeKey, path: string) => key === 'inputs'
    ? files.inputs.some(input => input.kind === 'workspace' && input.path === path)
    : files[key].includes(path)

  const togglePath = (key: ScopeKey, path: string) => {
    if (key === 'inputs') {
      const attachments = files.inputs.filter(input => input.kind === 'attachment')
      const workspacePaths = files.inputs
        .filter(input => input.kind === 'workspace')
        .map(input => input.path)
      const next = workspacePaths.includes(path)
        ? workspacePaths.filter(candidate => candidate !== path)
        : [...workspacePaths, path]
      setFiles({ ...files, inputs: [...attachments, ...next.map(candidate => ({ kind: 'workspace' as const, path: candidate }))] })
      return
    }
    setFiles({
      ...files,
      [key]: files[key].includes(path)
        ? files[key].filter(candidate => candidate !== path)
        : [...files[key], path],
    })
  }

  const addManualOutput = () => {
    const normalized = normalizeWorkspacePath(manualOutput)
    if (!normalized) {
      setErrors(['输出位置必须是安全的工作区相对路径。'])
      return
    }
    setFiles({ ...files, outputPaths: unique([...files.outputPaths, normalized]) })
    setManualOutput('')
    setErrors([])
  }

  const save = () => {
    const nextDeliverables = lines(deliverables)
    const nextChecks = lines(checks)
    const nextFiles = normalizeTaskFileScope(files)
    const nextErrors: string[] = []
    if (!title.trim()) nextErrors.push('任务标题不能为空。')
    if (!description.trim()) nextErrors.push('任务描述不能为空。')
    if (!prompt.trim()) nextErrors.push('核心 Prompt 不能为空。')
    if (nextDeliverables.length === 0) nextErrors.push('至少需要一项交付物。')
    if (nextChecks.length === 0) nextErrors.push('至少需要一项验收标准。')
    nextErrors.push(...validateTaskPathScope(nextFiles, { requireAuthorizedOutputs: Boolean(workspace) }).map(issue => issue.message))
    const knownEntries = new Set((workspace?.entries ?? []).map(entry => entry.path))
    const knownFiles = new Set((workspace?.entries ?? []).filter(entry => entry.kind === 'file').map(entry => entry.path))
    const unknownInputPath = nextFiles.inputs.flatMap(input => (
      input.kind === 'workspace' && !knownFiles.has(input.path) ? [input.path] : []
    ))[0]
    if (unknownInputPath && workspace) nextErrors.push(`输入文件不在当前工作区清单中：${unknownInputPath}`)
    if (workspace) {
      const unknownScopePath = [...nextFiles.allowedWritePaths, ...nextFiles.forbiddenPaths]
        .find(candidate => !knownEntries.has(candidate))
      if (unknownScopePath) nextErrors.push(`文件授权范围不在当前工作区清单中：${unknownScopePath}`)
    }
    if (nextErrors.length > 0) {
      setErrors(unique(nextErrors))
      return
    }

    const recommendation = recommendTaskProvider({
      title: title.trim(),
      description: description.trim(),
      prompt: prompt.trim(),
      globalTaskType: taskType,
      files: nextFiles.inputs,
      availableProviders: providers,
    })
    const saved = onSave({
      title: title.trim(),
      description: description.trim(),
      prompt: prompt.trim(),
      files: nextFiles,
      expectedDeliverables: nextDeliverables,
      acceptanceChecks: nextChecks,
      recommendedProviderId: recommendation.recommendedProviderId,
      providerRecommendation: recommendation.recommendation,
    })
    if (saved) {
      setErrors([])
      setEditing(false)
    }
  }

  if (!editing) return (
    <button
      type="button"
      className="task-definition-edit"
      disabled={disabled}
      onClick={() => { reset(); setEditing(true) }}
    >
      {disabled ? '任务已锁定' : '编辑任务与文件授权'}
    </button>
  )

  return (
    <section className="task-definition-editor">
      <h3>编辑任务</h3>
      <label>任务标题<input value={title} maxLength={12_000} onChange={event => setTitle(event.target.value)} /></label>
      <label>任务描述<textarea value={description} rows={3} maxLength={12_000} onChange={event => setDescription(event.target.value)} /></label>
      <label>核心 Prompt<textarea value={prompt} rows={6} maxLength={12_000} onChange={event => setPrompt(event.target.value)} /></label>
      <label>交付物（每行一项）<textarea value={deliverables} rows={3} onChange={event => setDeliverables(event.target.value)} /></label>
      <label>验收标准（每行一项）<textarea value={checks} rows={3} onChange={event => setChecks(event.target.value)} /></label>

      <div className="task-workspace-scope-editor">
        <strong>逐任务文件授权</strong>
        {workspace
          ? <>
            <input
              value={search}
              onChange={event => setSearch(event.target.value)}
              placeholder="搜索工作区相对路径"
              aria-label="搜索工作区路径"
            />
            <div className="task-workspace-entry-list">
              {visibleEntries.map(entry => (
                <div key={`${entry.kind}:${entry.path}`}>
                  <span title={entry.path}>{entry.kind === 'directory' ? '目录' : '文件'} · {entry.path}</span>
                  {entry.kind === 'file' && <button type="button" className={hasPath('inputs', entry.path) ? 'is-selected' : ''} onClick={() => togglePath('inputs', entry.path)}>输入</button>}
                  <button type="button" className={hasPath('allowedWritePaths', entry.path) ? 'is-selected' : ''} onClick={() => togglePath('allowedWritePaths', entry.path)}>可改</button>
                  <button type="button" className={hasPath('forbiddenPaths', entry.path) ? 'is-selected' : ''} onClick={() => togglePath('forbiddenPaths', entry.path)}>禁止</button>
                  <button type="button" className={hasPath('outputPaths', entry.path) ? 'is-selected' : ''} onClick={() => togglePath('outputPaths', entry.path)}>输出</button>
                </div>
              ))}
            </div>
            <div className="task-manual-output">
              <input value={manualOutput} onChange={event => setManualOutput(event.target.value)} placeholder="新输出路径，例如 reports/result.md" />
              <button type="button" onClick={addManualOutput}>添加输出</button>
            </div>
          </>
          : <p>请先在任务方案顶部选择项目文件夹；当前仍可编辑任务文字。</p>}
      </div>

      {errors.length > 0 && <ul className="task-definition-errors" role="alert">{errors.map(error => <li key={error}>{error}</li>)}</ul>}
      <div className="task-definition-actions">
        <button type="button" className="is-primary" onClick={save}>保存并重新推荐 AI</button>
        <button type="button" onClick={cancel}>取消编辑</button>
      </div>
    </section>
  )
}
