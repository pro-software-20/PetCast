import {
  CHATGPT_AUTH_MESSAGES,
  type ChatGptSessionResult,
} from '../../electron/chatGptAuthProtocol'

export type ChatGptAuthState =
  | { status: 'browser' }
  | { status: 'loading' | 'connecting' | 'signing-out' }
  | { status: 'result'; result: ChatGptSessionResult }

export function describeChatGptAuth(state: ChatGptAuthState): {
  tone: 'ready' | 'checking' | 'warning'
  title: string
  message: string
  connected: boolean
} {
  if (state.status === 'browser') return {
    tone: 'warning',
    title: 'ChatGPT 连接仅桌面版可用',
    message: '当前仍可复制任务 Prompt，前往所选 AI 手动执行。',
    connected: false,
  }
  if (state.status === 'loading') return {
    tone: 'checking', title: '正在读取 ChatGPT 连接', message: '不会调用模型或产生推理用量。', connected: false,
  }
  if (state.status === 'connecting') return {
    tone: 'checking', title: '正在等待 ChatGPT 授权', message: '请在系统浏览器中完成登录和授权。', connected: false,
  }
  if (state.status === 'signing-out') return {
    tone: 'checking', title: '正在断开 ChatGPT', message: '正在撤销可续期会话并清理本机凭据。', connected: false,
  }
  if (state.status !== 'result') return {
    tone: 'warning', title: 'ChatGPT 连接不可用', message: '请稍后重试。', connected: false,
  }
  if (state.result.ok && state.result.status === 'connected') return {
    tone: 'ready',
    title: 'ChatGPT 已连接',
    message: `${state.result.displayName ?? state.result.maskedEmail ?? '当前账号'}；符合条件的调用将使用此账号的 ChatGPT 计划。`,
    connected: true,
  }
  if (state.result.ok) return {
    tone: 'warning',
    title: '连接 ChatGPT 计划',
    message: state.result.remoteRevocationConfirmed === false
      ? '本机凭据已清除，但远程撤销未确认；可前往 ChatGPT 设置检查。'
      : '连接后可在隔离副本中使用 Codex 自动执行，无需填写 API Key。',
    connected: false,
  }
  return {
    tone: 'warning',
    title: 'ChatGPT 连接不可用',
    message: CHATGPT_AUTH_MESSAGES[state.result.code],
    connected: false,
  }
}

