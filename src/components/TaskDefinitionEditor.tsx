import { useState } from 'react'
import type { WorkspaceSnapshot } from '../../electron/workspaceProtocol'
import {
  applyWorkspacePathScope,
  getTaskWorkspacePathScope,
  normalizeTaskFileScope,
  validateTaskPathScope,
  workspacePathScopesEqual,
} from '../orchestration/taskPathScope'
import { recommendTaskProvider } from '../orchestration/taskRecommendation'
import type { EditableTaskDefinition } from '../orchestration/taskSession'
import type { ProviderProfile, TaskNode, WorkspacePathScope } from '../types/taskOrchestration'
import { WorkspaceScopePicker } from './WorkspaceScopePicker'
import { WorkspaceScopeSummary } from './WorkspaceScopeSummary'

interface TaskDefinitionEditorProps {
  task: TaskNode
  taskType: string
  providers: ProviderProfile[]
  workspace?: WorkspaceSnapshot
  defaultScope?: WorkspacePathScope
  disabled: boolean
  onSave: (task: EditableTaskDefinition) => boolean
}

const lines = (value: string) => value.split(/\r?\n/).map(item => item.trim()).filter(Boolean)
const textList = (value: string[]) => value.join('\n')
const unique = (values: string[]) => [...new Set(values)]

export function TaskDefinitionEditor({
  task,
  taskType,
  providers,
  workspace,
  defaultScope,
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
  const [scopeOpen, setScopeOpen] = useState(false)
  const [errors, setErrors] = useState<string[]>([])

  const currentScope = getTaskWorkspacePathScope(files)
  const inheritsDefault = Boolean(defaultScope && workspacePathScopesEqual(currentScope, defaultScope))

  const reset = () => {
    setTitle(task.title)
    setDescription(task.description)
    setPrompt(task.prompt)
    setDeliverables(textList(task.expectedDeliverables))
    setChecks(textList(task.acceptanceChecks))
    setFiles(structuredClone(task.files))
    setScopeOpen(false)
    setErrors([])
  }

  const cancel = () => {
    reset()
    setEditing(false)
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
    if (workspace) {
      const knownEntries = new Set(workspace.entries.map(entry => entry.path))
      const unknownScopePath = [
        ...(nextFiles.readPaths ?? []),
        ...nextFiles.allowedWritePaths,
        ...nextFiles.forbiddenPaths,
      ].find(candidate => !knownEntries.has(candidate))
      if (unknownScopePath) nextErrors.push(`文件授权范围不在当前工作区清单中：${unknownScopePath}`)
    }
    if (nextErrors.length > 0) {
      setErrors(unique(nextErrors))
      return
    }

    const recommendationFiles = [
      ...nextFiles.inputs,
      ...(nextFiles.readPaths ?? []).map(path => ({ kind: 'workspace' as const, path })),
    ]
    const recommendation = recommendTaskProvider({
      title: title.trim(),
      description: description.trim(),
      prompt: prompt.trim(),
      globalTaskType: taskType,
      files: recommendationFiles,
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
    <button type="button" className="task-definition-edit" disabled={disabled} onClick={() => { reset(); setEditing(true) }}>
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
        <div className="task-scope-heading">
          <strong>任务文件授权</strong>
          {defaultScope && <span>{inheritsDefault ? '继承全局默认' : '已单独调整'}</span>}
        </div>
        <WorkspaceScopeSummary scope={currentScope} compact />
        {workspace
          ? <div className="task-scope-actions">
            <button type="button" onClick={() => setScopeOpen(true)}>单独调整</button>
            {defaultScope && !inheritsDefault && <button type="button" onClick={() => setFiles(applyWorkspacePathScope(files, defaultScope))}>恢复全局默认</button>}
          </div>
          : <p>请先在任务方案顶部选择项目文件夹；当前仍可编辑任务文字。</p>}
      </div>

      {errors.length > 0 && <ul className="task-definition-errors" role="alert">{errors.map(error => <li key={error}>{error}</li>)}</ul>}
      <div className="task-definition-actions">
        <button type="button" className="is-primary" onClick={save}>保存并重新推荐 AI</button>
        <button type="button" onClick={cancel}>取消编辑</button>
      </div>

      {scopeOpen && workspace && (
        <WorkspaceScopePicker
          title={`调整“${title.trim() || task.title}”的文件范围`}
          workspace={workspace}
          initialScope={currentScope}
          onSave={(scope) => {
            setFiles(applyWorkspacePathScope(files, scope))
            setScopeOpen(false)
          }}
          onClose={() => setScopeOpen(false)}
        />
      )}
    </section>
  )
}
