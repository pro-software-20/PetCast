/** Only this allowlisted DTO crosses the preload boundary. No raw RPC errors or account details. */
export type CodexUsageErrorCode =
  | 'CLI_NOT_FOUND' | 'LOGIN_REQUIRED' | 'UNSUPPORTED_ACCOUNT' | 'UNSUPPORTED_WINDOWS'
  | 'ACCOUNT_CHANGED' | 'TIMEOUT' | 'CANCELLED' | 'UNAVAILABLE' | 'INVALID_RESPONSE'

export interface CodexQuotaSnapshot {
  diagnostics?: CodexQuotaDiagnostics
  scopeId: string
  /** Optional opaque account/workspace scope supplied when the upstream response has accountId. */
  accountScopeId?: string
  sampledAt: string
  shortWindowRemaining: number
  weeklyRemaining: number
  shortWindowResetAt: string
  weeklyResetAt: string
}

/** Local troubleshooting only: no full email, account ID, credentials or filesystem paths. */
export interface CodexQuotaDiagnostics {
  accountLabel: string | null
  planType: 'free' | 'plus' | 'pro' | 'team' | 'business' | 'enterprise' | 'edu' | 'unknown'
  executableSource: 'override' | 'path' | 'desktop' | 'explicit'
  customHome: boolean
  workspaceIdentified: boolean
  selectedBucket: 'codex'
  buckets: Array<{ id: string; windows: Array<{ minutes: number | null; usedPercent: number | null; resetsAt: string | null }> }>
}

export type CodexQuotaResult =
  | { ok: true; snapshot: CodexQuotaSnapshot }
  | { ok: false; code: CodexUsageErrorCode; scopeId?: string; accountScopeId?: string }

export const CODEX_USAGE_MESSAGES: Record<CodexUsageErrorCode, string> = {
  CLI_NOT_FOUND: '未找到 Codex。请安装 Codex CLI，或设置 PETCAST_CODEX_PATH 指向 codex.exe。',
  LOGIN_REQUIRED: '请先在本机 Codex 登录 ChatGPT 账号，然后重新读取。',
  UNSUPPORTED_ACCOUNT: '当前登录方式不提供 Codex 订阅额度，请使用 ChatGPT 账号登录。',
  UNSUPPORTED_WINDOWS: '当前账号未返回完整的 5 小时和周额度，暂时无法显示。',
  ACCOUNT_CHANGED: '读取期间账号发生变化，请重新读取。',
  TIMEOUT: '读取 Codex 额度超时，请稍后重试。',
  CANCELLED: '已取消读取。',
  UNAVAILABLE: 'Codex 服务暂时不可用，请检查网络和本机登录状态。',
  INVALID_RESPONSE: 'Codex 返回的数据格式暂不支持，请更新 Codex 后重试。',
}
