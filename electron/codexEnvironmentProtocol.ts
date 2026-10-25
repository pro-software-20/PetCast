export const MINIMUM_CODEX_VERSION = '0.163.0' as const

export type CodexEnvironmentErrorCode =
  | 'CLI_NOT_FOUND'
  | 'VERSION_UNSUPPORTED'
  | 'AUTH_REQUIRED'
  | 'SCOPE_MISSING'
  | 'REAUTH_REQUIRED'
  | 'STORAGE_UNAVAILABLE'
  | 'LOGIN_REQUIRED'
  | 'UNSUPPORTED_ACCOUNT'
  | 'ACCOUNT_CHANGED'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'UNAVAILABLE'
  | 'INVALID_RESPONSE'

export type CodexEnvironmentResult =
  | {
      ok: true
      checkedAt: string
      cliVersion: string
      minimumVersion: typeof MINIMUM_CODEX_VERSION
      scopeId: string
      authMode: 'chatgpt-oauth' | 'local-codex-experimental'
    }
  | {
      ok: false
      code: CodexEnvironmentErrorCode
      checkedAt: string
      cliVersion?: string
      minimumVersion: typeof MINIMUM_CODEX_VERSION
    }

export const CODEX_ENVIRONMENT_MESSAGES: Record<CodexEnvironmentErrorCode, string> = {
  CLI_NOT_FOUND: '未找到 Codex。请安装 Codex 桌面版或 CLI 后重新检查。',
  VERSION_UNSUPPORTED: `Codex 版本过低，请升级到 ${MINIMUM_CODEX_VERSION} 或以上版本。`,
  AUTH_REQUIRED: '请先使用 ChatGPT 账号连接 PetCast。',
  SCOPE_MISSING: '当前账号尚未授权 PetCast 使用 ChatGPT 计划，请重新连接并同意授权。',
  REAUTH_REQUIRED: 'ChatGPT 登录已失效，请重新连接。',
  STORAGE_UNAVAILABLE: '系统安全存储不可用，PetCast 不会以明文保存登录凭据。',
  LOGIN_REQUIRED: '请先在本机 Codex 登录 ChatGPT 账号，然后重新检查。',
  UNSUPPORTED_ACCOUNT: '当前登录方式不支持自动执行，请改用 ChatGPT 账号登录。',
  ACCOUNT_CHANGED: '检查期间 Codex 账号发生变化，请重新检查。',
  TIMEOUT: 'Codex 环境检查超时，请检查网络或重启 Codex 后重试。',
  CANCELLED: 'Codex 环境检查已取消。',
  UNAVAILABLE: 'Codex 服务暂时不可用，请检查网络或重启 Codex 后重试。',
  INVALID_RESPONSE: 'Codex 返回的数据格式暂不支持，请更新 Codex 后重试。',
}
