import { useEffect, useState } from 'react'

export function CodexActivity({ kind, since = 0, taskIds }: { kind: 'planning' | 'execution' | 'connection'; since?: number; taskIds?: string[] }) {
  const [items, setItems] = useState<Awaited<ReturnType<NonNullable<Window['petcast']>['readCodexActivity']>>>([])
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout>
    const check = async () => {
      try {
        const result = await window.petcast?.readCodexActivity?.()
        if (active && result) setItems(result)
      } catch { /* connection status is shown by the parent */ }
      if (active) timer = setTimeout(() => void check(), 1000)
    }
    void check()
    return () => { active = false; clearTimeout(timer) }
  }, [])
  const visible = items.filter(item => item.kind === kind && Date.parse(item.updatedAt) >= since
    && (!taskIds || (item.taskId && taskIds.includes(item.taskId)))).slice(-4)
  return visible.length ? <div className="task-session-restore" role="status" aria-live="polite">
    {visible.map(item => <p key={item.id}><strong>{item.active ? 'Codex 处理中' : 'Codex 状态'}</strong> · {item.message}
      {item.active && Date.now() - Date.parse(item.updatedAt) > 5000 && <span>（此阶段已等待 {Math.floor((Date.now() - Date.parse(item.updatedAt)) / 1000)} 秒）</span>}
    </p>)}
  </div> : null
}
