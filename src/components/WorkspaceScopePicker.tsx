import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type { WorkspaceSnapshot } from '../../electron/workspaceProtocol'
import {
  normalizeWorkspacePath,
  normalizeWorkspacePathScope,
  pathContains,
  validateTaskPathScope,
} from '../orchestration/taskPathScope'
import { buildWorkspaceTree, filterWorkspaceTree, type WorkspaceTreeNode } from '../orchestration/workspaceTree'
import type { WorkspacePathScope } from '../types/taskOrchestration'
import { WorkspaceScopeSummary } from './WorkspaceScopeSummary'

type ScopeKey = keyof WorkspacePathScope

interface WorkspaceScopePickerProps {
  title: string
  workspace: WorkspaceSnapshot
  initialScope: WorkspacePathScope
  onSave: (scope: WorkspacePathScope) => void
  onClose: () => void
}

const tabs: Array<{ key: ScopeKey; label: string; advanced?: boolean }> = [
  { key: 'readPaths', label: '读取范围' },
  { key: 'allowedWritePaths', label: '可修改范围' },
  { key: 'forbiddenPaths', label: '禁止范围', advanced: true },
  { key: 'outputPaths', label: '输出位置', advanced: true },
]

const emptyScope = (): WorkspacePathScope => ({
  readPaths: [],
  allowedWritePaths: [],
  forbiddenPaths: [],
  outputPaths: [],
})

export function WorkspaceScopePicker({
  title,
  workspace,
  initialScope,
  onSave,
  onClose,
}: WorkspaceScopePickerProps) {
  const [scope, setScope] = useState(() => normalizeWorkspacePathScope(initialScope))
  const [activeKey, setActiveKey] = useState<ScopeKey>('readPaths')
  const [advanced, setAdvanced] = useState(false)
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [manualOutput, setManualOutput] = useState('')
  const [errors, setErrors] = useState<string[]>([])

  const fullTree = useMemo(() => buildWorkspaceTree(workspace.entries), [workspace.entries])
  const tree = useMemo(() => filterWorkspaceTree(fullTree, search), [fullTree, search])
  const knownEntries = useMemo(() => new Set(workspace.entries.map(entry => entry.path)), [workspace.entries])

  const togglePath = (path: string) => {
    const current = scope[activeKey]
    setScope({
      ...scope,
      [activeKey]: current.includes(path)
        ? current.filter(candidate => candidate !== path)
        : [...current, path],
    })
    setErrors([])
  }

  const toggleDirectory = (path: string) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const renderNodes = (nodes: WorkspaceTreeNode[], depth = 0): React.ReactNode => nodes.map((node) => {
    const selected = scope[activeKey]
    const exact = selected.includes(node.path)
    const inherited = !exact && selected.some(parent => pathContains(parent, node.path))
    const open = Boolean(search.trim()) || expanded.has(node.path)
    return (
      <div key={`${node.kind}:${node.path}`}>
        <div className="workspace-tree-row" style={{ paddingLeft: `${depth * 13 + 4}px` }}>
          {node.kind === 'directory'
            ? <button type="button" className="workspace-tree-toggle" onClick={() => toggleDirectory(node.path)} aria-label={`${open ? '收起' : '展开'} ${node.path}`}>{open ? '▾' : '▸'}</button>
            : <span className="workspace-tree-spacer" />}
          <label title={node.path}>
            <input
              type="checkbox"
              checked={exact || inherited}
              disabled={inherited}
              onChange={() => togglePath(node.path)}
            />
            <span>{node.kind === 'directory' ? '📁' : '📄'} {node.name}</span>
            {inherited && <small>已由父目录授权</small>}
          </label>
        </div>
        {node.kind === 'directory' && open && renderNodes(node.children, depth + 1)}
      </div>
    )
  })

  const addManualOutput = () => {
    const normalized = normalizeWorkspacePath(manualOutput)
    if (!normalized) {
      setErrors(['输出位置必须是安全的工作区相对路径。'])
      return
    }
    setScope({ ...scope, outputPaths: [...new Set([...scope.outputPaths, normalized])] })
    setManualOutput('')
    setErrors([])
  }

  const save = () => {
    const normalized = normalizeWorkspacePathScope(scope)
    const nextErrors = validateTaskPathScope({
      inputs: [],
      readPaths: normalized.readPaths,
      allowedWritePaths: normalized.allowedWritePaths,
      forbiddenPaths: normalized.forbiddenPaths,
      outputPaths: normalized.outputPaths,
    }, { requireAuthorizedOutputs: true }).map(issue => issue.message)
    const existingPath = [...normalized.readPaths, ...normalized.allowedWritePaths, ...normalized.forbiddenPaths]
      .find(path => !knownEntries.has(path))
    if (existingPath) nextErrors.push(`授权路径不在当前工作区清单中：${existingPath}`)
    if (nextErrors.length > 0) {
      setErrors([...new Set(nextErrors)])
      return
    }
    onSave(normalized)
  }

  return createPortal(
    <div className="workspace-scope-overlay" role="presentation" onPointerDown={event => event.stopPropagation()}>
      <section className="workspace-scope-dialog" role="dialog" aria-modal="true" aria-labelledby="workspace-scope-title">
        <header>
          <div>
            <small>{workspace.displayName}</small>
            <h3 id="workspace-scope-title">{title}</h3>
          </div>
          <button type="button" aria-label="关闭文件授权" onClick={onClose}>×</button>
        </header>

        <WorkspaceScopeSummary scope={scope} compact />

        <div className="workspace-scope-tabs" role="tablist">
          {tabs.filter(tab => advanced || !tab.advanced).map(tab => (
            <button
              type="button"
              role="tab"
              aria-selected={activeKey === tab.key}
              className={activeKey === tab.key ? 'is-active' : ''}
              key={tab.key}
              onClick={() => setActiveKey(tab.key)}
            >
              {tab.label}（{scope[tab.key].length}）
            </button>
          ))}
          <button type="button" onClick={() => setAdvanced(value => !value)}>{advanced ? '收起高级设置' : '高级设置'}</button>
        </div>

        <div className="workspace-scope-toolbar">
          <input value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索文件或目录" aria-label="搜索工作区路径" />
          <button type="button" onClick={() => setScope({ ...scope, [activeKey]: [] })}>清空当前分类</button>
          <button type="button" onClick={() => setScope(emptyScope())}>无项目文件访问</button>
        </div>

        <div className="workspace-tree" aria-label="项目目录树">
          {tree.length > 0 ? renderNodes(tree) : <p>没有匹配的文件或目录。</p>}
        </div>

        {activeKey === 'outputPaths' && (
          <div className="workspace-manual-output">
            <input value={manualOutput} onChange={event => setManualOutput(event.target.value)} placeholder="新输出路径，例如 reports/result.md" />
            <button type="button" onClick={addManualOutput}>添加新输出</button>
          </div>
        )}

        {errors.length > 0 && <ul className="workspace-scope-errors" role="alert">{errors.map(error => <li key={error}>{error}</li>)}</ul>}
        <footer>
          <button type="button" className="is-primary" onClick={save}>保存文件授权</button>
          <button type="button" onClick={onClose}>取消</button>
        </footer>
      </section>
    </div>,
    document.body,
  )
}
