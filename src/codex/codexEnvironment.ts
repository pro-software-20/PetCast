import {
  CODEX_ENVIRONMENT_MESSAGES,
  type CodexEnvironmentResult,
} from '../../electron/codexEnvironmentProtocol'

export type CodexEnvironmentState =
  | { status: 'browser' }
  | { status: 'checking' }
  | { status: 'ready'; result: Extract<CodexEnvironmentResult, { ok: true }> }
  | { status: 'error'; result: Extract<CodexEnvironmentResult, { ok: false }> }

export interface CodexEnvironmentPresentation {
  tone: 'ready' | 'checking' | 'warning'
  title: string
  message: string
  version?: string
}

export function describeCodexEnvironment(state: CodexEnvironmentState): CodexEnvironmentPresentation {
  if (state.status === 'browser') return {
    tone: 'warning',
    title: 'Codex 自动执行仅桌面版可用',
    message: '当前仍可复制任务 Prompt，前往其他 AI 手动执行。',
  }
  if (state.status === 'checking') return {
    tone: 'checking',
    title: '正在检查本机 Codex',
    message: '只检查安装、版本和登录状态，不会调用模型或消耗推理 Token。',
  }
  if (state.status === 'ready') return {
    tone: 'ready',
    title: 'Codex 已就绪',
    message: state.result.authMode === 'chatgpt-oauth'
      ? '已连接 ChatGPT，可以使用自己的计划在隔离副本中执行；人工复制仍然可用。'
      : '正在使用本机 Codex 登录实验回退；人工复制仍然可用。',
    version: state.result.cliVersion,
  }
  return {
    tone: 'warning',
    title: 'Codex 自动执行暂不可用',
    message: `${CODEX_ENVIRONMENT_MESSAGES[state.result.code]} 你仍可复制任务 Prompt 手动执行。`,
    version: state.result.cliVersion,
  }
}

export function getCodexExecutionAccess(state: CodexEnvironmentState): {
  available: boolean
  scopeId?: string
  authMode?: 'chatgpt-oauth' | 'local-codex-experimental'
  message: string
} {
  if (state.status === 'ready') return {
    available: true,
    scopeId: state.result.scopeId,
    authMode: state.result.authMode,
    message: `Codex ${state.result.cliVersion} 已通过环境自检。`,
  }
  if (state.status === 'checking') return { available: false, message: '正在检查本机 Codex，请稍候。' }
  if (state.status === 'browser') return { available: false, message: 'Codex 自动执行仅桌面版可用。' }
  return {
    available: false,
    message: CODEX_ENVIRONMENT_MESSAGES[state.result.code],
  }
}
