import type { WorkspacePathScope } from '../types/taskOrchestration'

interface WorkspaceScopeSummaryProps {
  scope: WorkspacePathScope
  inherited?: boolean
  compact?: boolean
}

const summarize = (paths: string[], empty: string) => {
  if (paths.length === 0) return empty
  const visible = paths.slice(0, 3).join('、')
  return paths.length > 3 ? `${visible} 等 ${paths.length} 项` : visible
}

export function WorkspaceScopeSummary({ scope, inherited, compact }: WorkspaceScopeSummaryProps) {
  return (
    <div className={`workspace-scope-summary${compact ? ' is-compact' : ''}`}>
      {inherited !== undefined && <strong>{inherited ? '继承全局授权' : '已单独调整'}</strong>}
      <dl>
        <div><dt>读取</dt><dd>{summarize(scope.readPaths, '无')}</dd></div>
        <div><dt>修改</dt><dd>{summarize(scope.allowedWritePaths, '无')}</dd></div>
        <div><dt>禁止</dt><dd>{summarize(scope.forbiddenPaths, '无')}</dd></div>
        <div><dt>输出</dt><dd>{summarize(scope.outputPaths, '待确认')}</dd></div>
      </dl>
    </div>
  )
}
