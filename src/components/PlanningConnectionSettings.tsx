import { useEffect, useState } from 'react'
import type { TaskBrainId } from '../types/taskOrchestration'
import { DeepSeekConnectionSettings } from './DeepSeekConnectionSettings'
import { CodexActivity } from './CodexActivity'

export function PlanningConnectionSettings({ brain, disabled, onReady }: { brain: TaskBrainId; disabled: boolean; onReady: (ready: boolean) => void }) {
  const [connected, setConnected] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  useEffect(() => {
    let active = true
    setConnected(false)
    onReady(brain === 'local')
    setMessage('')
    const check = async () => {
      try {
        const status = brain === 'codex' ? await window.petcast?.readCodexQueueStatus?.()
          : brain === 'deepseek' ? await window.petcast?.readDeepSeekConnection?.() : { configured: true }
        if (active) { setConnected(Boolean(status?.configured)); onReady(Boolean(status?.configured)) }
      } catch { if (active) { setConnected(false); onReady(false) } }
    }
    void check()
    window.addEventListener('petcast:execution-connection-changed', check)
    return () => { active = false; window.removeEventListener('petcast:execution-connection-changed', check) }
  }, [brain, onReady])
  if (brain === 'local') return null
  return <fieldset disabled={disabled || busy} style={{ border: 0, padding: 0 }}>
    {brain === 'deepseek' ? <DeepSeekConnectionSettings initiallyOpen /> : <>
      <p>先在本机 Codex 登录 ChatGPT，再点击连接。使用该账户额度，无需另填 API Key；连接检测不发送任务。</p>
      <button type="button" disabled={!window.petcast?.connectCodexQueue} onClick={async () => {
        setBusy(true); setMessage('正在核对登录和执行通道…')
        try {
          const result = await window.petcast!.connectCodexQueue()
          setConnected(result.configured); onReady(result.configured); setMessage(result.message)
          window.dispatchEvent(new Event('petcast:execution-connection-changed'))
        } catch { setConnected(false); onReady(false); setMessage('连接失败，请检查 Codex 登录和网络。') }
        finally { setBusy(false) }
      }}>{busy ? '连接中…' : connected ? '重新检测 Codex 连接' : '连接并允许使用本机 Codex'}</button>
      <p role="status">{message}</p>
      {busy && <CodexActivity kind="connection" />}
    </>}
    <p role="status">{connected ? '连接已就绪：开始分析会调用所选 AI 拆解任务并推荐执行 AI。执行仍需启动任务队列。' : '尚未连接：现在开始分析将使用本地规则，不会发送给其他 AI。'}</p>
  </fieldset>
}
