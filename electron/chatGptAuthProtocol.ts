export type ChatGptAuthErrorCode =
  | 'AUTH_REQUIRED'
  | 'CANCELLED'
  | 'TIMEOUT'
  | 'SCOPE_MISSING'
  | 'REAUTH_REQUIRED'
  | 'AUTHORIZATION_RETRY_REQUIRED'
  | 'REGION_UNSUPPORTED'
  | 'NETWORK_UNAVAILABLE'
  | 'STORAGE_UNAVAILABLE'
  | 'UNAVAILABLE'
  | 'INVALID_RESPONSE'

export class ChatGptAuthError extends Error {
  constructor(readonly code: ChatGptAuthErrorCode) { super(code) }
}

export interface ChatGptConnectedSession {
  ok: true
  status: 'connected'
  scopeId: string
  sharing: true
  checkedAt: string
  displayName?: string
  maskedEmail?: string
}

export interface ChatGptDisconnectedSession {
  ok: true
  status: 'disconnected'
  sharing: false
  checkedAt: string
  remoteRevocationConfirmed?: boolean
}

export type ChatGptSessionResult =
  | ChatGptConnectedSession
  | ChatGptDisconnectedSession
  | {
      ok: false
      code: ChatGptAuthErrorCode
      checkedAt: string
      displayName?: string
      maskedEmail?: string
    }

export const CHATGPT_AUTH_MESSAGES: Record<ChatGptAuthErrorCode, string> = {
  AUTH_REQUIRED: '请先使用 ChatGPT 账号连接 PetCast。',
  CANCELLED: 'ChatGPT 登录已取消。',
  TIMEOUT: 'ChatGPT 登录等待超时，请重新尝试。',
  SCOPE_MISSING: '账号已登录，但尚未授权 PetCast 使用 ChatGPT 计划。请重新连接并同意授权。',
  REAUTH_REQUIRED: 'ChatGPT 登录已失效，请重新连接。',
  AUTHORIZATION_RETRY_REQUIRED: '首次注册已完成，但本次授权码无法继续使用。请重新授权。',
  REGION_UNSUPPORTED: '当前地区无法使用 ChatGPT 授权。你仍可复制任务 Prompt，前往可用的 AI 手动执行。',
  NETWORK_UNAVAILABLE: '暂时无法连接 ChatGPT 登录服务，请检查网络后重试。',
  STORAGE_UNAVAILABLE: '系统安全存储不可用，PetCast 不会以明文保存登录凭据。',
  UNAVAILABLE: 'ChatGPT 登录服务暂时不可用，请稍后重试。',
  INVALID_RESPONSE: 'ChatGPT 登录返回了无法验证的数据，请重新尝试。',
}

export const isChatGptAuthRequestId = (value: unknown): value is string => (
  typeof value === 'string' && /^[A-Za-z0-9._:-]{1,160}$/.test(value)
)
