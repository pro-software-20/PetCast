import { useEffect, useRef, useState } from 'react'

export function DeepSeekConnectionSettings({ initiallyOpen = false }: { initiallyOpen?: boolean } = {}) {
  const [open, setOpen] = useState(initiallyOpen)
  const keyInput = useRef<HTMLInputElement>(null)
  const [model, setModel] = useState('deepseek-flash')
  const [connected, setConnected] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('正在检查执行连接…')
  useEffect(() => {
    let active = true
    void window.petcast?.readDeepSeekConnection?.().then(status => {
      if (!active) return
      setConnected(status.configured)
      setModel(status.model || 'deepseek-flash')
      setMessage(status.configured ? '已配置个人账户；执行按该账户计费。' : '尚未连接个人账户，自动执行不可用。')
    }).catch(() => { if (active) setMessage('执行连接检查失败，请重试。') })
    if (!window.petcast?.readDeepSeekConnection) setMessage('请使用桌面版连接执行账户。')
    return () => { active = false }
  }, [])
  const connect = async () => {
    if (!keyInput.current || !window.petcast?.configureDeepSeekConnection) return
    const apiKey = keyInput.current.value.trim()
    keyInput.current.value = ''
    setBusy(true)
    try {
      const result = await window.petcast.configureDeepSeekConnection({ apiKey, model: model.trim() })
      setMessage(result.message)
      if (result.ok) { setConnected(true); window.dispatchEvent(new Event('petcast:execution-connection-changed')) }
    } catch { setMessage('连接失败，请检查网络后重试。') }
    finally { setBusy(false) }
  }
  return <details className="task-session-restore" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>执行账户 · {connected ? 'DeepSeek 已配置' : '需要连接'}</summary>
    <p>连接后，DeepSeek 拆解和执行使用你的 API 账户。网页会员或网页登录不能替代 API Key。本次连接仅在应用运行期间保留，退出后重新连接。</p>
    <label>API Key <input ref={keyInput} type="password" autoComplete="off" disabled={busy} placeholder="在此粘贴，不会写入任务记录" /></label>
    <label>模型 <input value={model} onChange={e => setModel(e.target.value)} disabled={busy} maxLength={100} /></label>
    <button type="button" disabled={busy || !window.petcast?.configureDeepSeekConnection} onClick={() => void connect()}>{busy ? '检测中…' : '检测并连接我的账户'}</button>
    <p role="status">{message}</p>
    <p>检测只查询模型列表，不提交任务。软件、网页自动操作需有对应适配器；当前不能自动控制任意已登录的 AI。</p>
  </details>
}
