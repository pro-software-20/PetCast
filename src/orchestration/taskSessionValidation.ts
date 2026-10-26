import { validateTaskPlan } from './taskPlanValidation'
import { normalizeWorkspacePath } from './taskPathScope'
import {
  BUILT_IN_PROVIDER_IDS,
  TASK_STATUSES,
  type TaskNode,
  type TaskSessionV1,
  type TaskVerificationResult,
} from '../types/taskOrchestration'

export const MAX_TASK_RESULT_LENGTH = 50_000
export const MAX_TASK_SESSION_BYTES = 2 * 1024 * 1024

export type TaskSessionValidationIssueCode =
  | 'INVALID_SHAPE'
  | 'UNSUPPORTED_VERSION'
  | 'LIMIT_EXCEEDED'
  | 'INVALID_PLAN'
  | 'TASK_MISMATCH'
  | 'INVALID_STATE'
  | 'INVALID_PATH'
  | 'INVALID_DATE'

export interface TaskSessionValidationIssue {
  code: TaskSessionValidationIssueCode
  path: string
  message: string
}

export type TaskSessionValidationResult =
  | { ok: true; session: TaskSessionV1 }
  | { ok: false; issues: TaskSessionValidationIssue[] }

const statuses = new Set<string>(TASK_STATUSES)
const builtInProviders = new Set<string>(BUILT_IN_PROVIDER_IDS)
const customProviderPattern = /^custom:[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

const isNonEmptyString = (value: unknown) => typeof value === 'string' && value.trim().length > 0
const isIsoDate = (value: unknown) => (
  typeof value === 'string'
  && !Number.isNaN(Date.parse(value))
  && new Date(value).toISOString() === value
)
const isProviderId = (value: unknown) => (
  typeof value === 'string' && (builtInProviders.has(value) || customProviderPattern.test(value))
)
const isSafePath = (value: unknown) => (
  typeof value === 'string'
  && value.trim().length > 0
  && !value.includes('\0')
  && !value.includes(':')
  && !/^[\\/]/.test(value)
  && !value.split(/[\\/]+/).includes('..')
)

const push = (
  issues: TaskSessionValidationIssue[],
  code: TaskSessionValidationIssueCode,
  path: string,
  message: string,
) => issues.push({ code, path, message })

const validateDate = (
  value: unknown,
  path: string,
  issues: TaskSessionValidationIssue[],
  optional = false,
) => {
  if (optional && value === undefined) return
  if (!isIsoDate(value)) push(issues, 'INVALID_DATE', path, '必须是 UTC ISO 8601 时间。')
}

const expectedLabels = (task: TaskNode) => task.acceptanceChecks

const validateVerification = (
  value: unknown,
  expected: string[],
  path: string,
  issues: TaskSessionValidationIssue[],
) => {
  if (!Array.isArray(value) || value.length !== expected.length) {
    push(issues, 'TASK_MISMATCH', path, '验证项必须与任务验收标准一一对应。')
    return
  }
  value.forEach((candidate, index) => {
    if (!isRecord(candidate)) {
      push(issues, 'INVALID_SHAPE', `${path}[${index}]`, '验证项必须是对象。')
      return
    }
    if (candidate.label !== expected[index]) {
      push(issues, 'TASK_MISMATCH', `${path}[${index}].label`, '验证项名称与任务计划不一致。')
    }
    if (!['passed', 'failed', 'not-run'].includes(String(candidate.status))) {
      push(issues, 'INVALID_SHAPE', `${path}[${index}].status`, '验证状态无效。')
    }
    if (candidate.details !== undefined && typeof candidate.details !== 'string') {
      push(issues, 'INVALID_SHAPE', `${path}[${index}].details`, '验证说明必须是字符串。')
    }
  })
}

const validatePathList = (
  value: unknown,
  path: string,
  issues: TaskSessionValidationIssue[],
) => {
  if (!Array.isArray(value)) {
    push(issues, 'INVALID_SHAPE', path, '文件列表必须是数组。')
    return
  }
  value.forEach((candidate, index) => {
    if (!isSafePath(candidate)) push(issues, 'INVALID_PATH', `${path}[${index}]`, '必须是安全的工作区相对路径。')
  })
}

const validateHandoff = (
  value: unknown,
  changedFiles: unknown,
  path: string,
  issues: TaskSessionValidationIssue[],
) => {
  if (value === undefined) return
  if (!isRecord(value)
    || !isNonEmptyString(value.summary)
    || String(value.summary).length > 2_000
    || !Array.isArray(value.keyDecisions)
    || !Array.isArray(value.artifacts)
    || !Array.isArray(value.openQuestions)) {
    push(issues, 'INVALID_SHAPE', path, '任务交接包结构无效。')
    return
  }
  for (const [field, values] of [
    ['keyDecisions', value.keyDecisions],
    ['openQuestions', value.openQuestions],
  ] as const) {
    if (values.length > 50 || values.some(item => !isNonEmptyString(item) || String(item).length > 2_000)) {
      push(issues, 'LIMIT_EXCEEDED', `${path}.${field}`, '交接条目必须非空，且最多 50 项、每项 2,000 字符。')
    }
  }
  if (value.artifacts.length > 200) {
    push(issues, 'LIMIT_EXCEEDED', `${path}.artifacts`, '交接文件不能超过 200 项。')
  }
  const artifactPaths: string[] = []
  value.artifacts.forEach((artifact, index) => {
    if (!isRecord(artifact)
      || normalizeWorkspacePath(String(artifact.path ?? '')) !== artifact.path
      || !isNonEmptyString(artifact.description)
      || String(artifact.description).length > 1_000) {
      push(issues, 'INVALID_PATH', `${path}.artifacts[${index}]`, '交接文件必须使用安全相对路径和非空说明。')
      return
    }
    artifactPaths.push(String(artifact.path))
  })
  if (new Set(artifactPaths).size !== artifactPaths.length) {
    push(issues, 'INVALID_PATH', `${path}.artifacts`, '交接文件不能重复。')
  }
  if (Array.isArray(changedFiles)) {
    const normalizedChanged = changedFiles.flatMap(candidate => (
      typeof candidate === 'string' ? [normalizeWorkspacePath(candidate)].filter(Boolean) as string[] : []
    )).sort()
    if (JSON.stringify([...artifactPaths].sort()) !== JSON.stringify(normalizedChanged)) {
      push(issues, 'TASK_MISMATCH', `${path}.artifacts`, '交接文件必须与任务实际修改文件一致。')
    }
  }
}

const isStringArray = (value: unknown) => Array.isArray(value) && value.every(item => typeof item === 'string')
const isTokenRange = (value: unknown) => (
  isRecord(value)
  && Number.isInteger(value.min)
  && Number.isInteger(value.max)
  && Number(value.min) >= 0
  && Number(value.min) <= Number(value.max)
)

export function validateTaskSession(value: unknown): TaskSessionValidationResult {
  const issues: TaskSessionValidationIssue[] = []
  if (!isRecord(value)) {
    return { ok: false, issues: [{ code: 'INVALID_SHAPE', path: '$', message: '任务会话必须是对象。' }] }
  }

  try {
    if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_TASK_SESSION_BYTES) {
      push(issues, 'LIMIT_EXCEEDED', '$', `任务会话不能超过 ${MAX_TASK_SESSION_BYTES} 字节。`)
    }
  } catch {
    push(issues, 'INVALID_SHAPE', '$', '任务会话必须可以安全序列化。')
  }

  if (value.schemaVersion !== 1) push(issues, 'UNSUPPORTED_VERSION', 'schemaVersion', '仅支持任务会话版本 1。')
  if (!isNonEmptyString(value.id)) push(issues, 'INVALID_SHAPE', 'id', '会话 ID 不能为空。')
  validateDate(value.createdAt, 'createdAt', issues)
  validateDate(value.updatedAt, 'updatedAt', issues)
  validateDate(value.completedAt, 'completedAt', issues, true)

  if (!isRecord(value.analysisInput) || typeof value.analysisInput.prompt !== 'string' || !Array.isArray(value.analysisInput.files)) {
    push(issues, 'INVALID_SHAPE', 'analysisInput', '分析输入结构无效。')
  } else {
    value.analysisInput.files.forEach((file, index) => {
      if (
        !isRecord(file)
        || !isNonEmptyString(file.name)
        || !isNonEmptyString(file.type)
        || typeof file.size !== 'number'
        || !Number.isFinite(file.size)
        || file.size < 0
      ) push(issues, 'INVALID_SHAPE', `analysisInput.files[${index}]`, '附件元信息无效。')
    })
  }

  if (
    !isRecord(value.analysisResult)
    || !isNonEmptyString(value.analysisResult.taskType)
    || !['low', 'medium', 'high'].includes(String(value.analysisResult.complexity))
    || !isTokenRange(value.analysisResult.estimatedInputTokens)
    || !isTokenRange(value.analysisResult.estimatedOutputTokens)
    || value.analysisResult.estimationBasis !== 'heuristic-metadata'
    || !isStringArray(value.analysisResult.assumptions)
    || typeof value.analysisResult.optimizedPrompt !== 'string'
    || !['deepseek', 'local'].includes(String(value.analysisResult.promptOptimizationSource))
    || typeof value.analysisResult.canRunInParallel !== 'boolean'
    || !isStringArray(value.analysisResult.parallelPlan)
    || !isStringArray(value.analysisResult.warnings)
  ) {
    push(issues, 'INVALID_SHAPE', 'analysisResult', '分析结果结构无效。')
  }

  const planResult = validateTaskPlan(value.plan)
  if (!planResult.ok) {
    push(issues, 'INVALID_PLAN', 'plan', '任务计划未通过严格校验。')
    return { ok: false, issues }
  }
  const plan = planResult.plan
  const taskById = new Map(plan.tasks.map(task => [task.id, task]))
  const runById = new Map<string, Record<string, unknown>>()

  if (!Array.isArray(value.runs) || value.runs.length !== plan.tasks.length) {
    push(issues, 'TASK_MISMATCH', 'runs', '运行记录必须与任务列表一一对应。')
  } else {
    value.runs.forEach((run, index) => {
      const path = `runs[${index}]`
      if (!isRecord(run) || typeof run.taskId !== 'string') {
        push(issues, 'INVALID_SHAPE', path, '运行记录结构无效。')
        return
      }
      const task = taskById.get(run.taskId)
      if (!task || runById.has(run.taskId)) {
        push(issues, 'TASK_MISMATCH', `${path}.taskId`, '运行记录任务 ID 不存在或重复。')
        return
      }
      runById.set(run.taskId, run)
      if (!statuses.has(String(run.status))) push(issues, 'INVALID_STATE', `${path}.status`, '任务状态无效。')
      if (!isProviderId(run.assignedProviderId)) push(issues, 'INVALID_SHAPE', `${path}.assignedProviderId`, 'Provider ID 无效。')
      if (!['manual', 'local-agent'].includes(String(run.executionMode))) {
        push(issues, 'INVALID_STATE', `${path}.executionMode`, '任务执行模式无效。')
      }
      if (!Number.isInteger(run.attempt) || Number(run.attempt) < 0) push(issues, 'INVALID_SHAPE', `${path}.attempt`, '尝试次数必须是非负整数。')
      validateDate(run.startedAt, `${path}.startedAt`, issues, true)
      validateDate(run.completedAt, `${path}.completedAt`, issues, true)
      if (run.statusMessage !== undefined && typeof run.statusMessage !== 'string') {
        push(issues, 'INVALID_SHAPE', `${path}.statusMessage`, '状态说明必须是字符串。')
      }
      if (run.automaticExecution !== undefined) {
        const automatic = run.automaticExecution
        if (!isRecord(automatic)
          || !isNonEmptyString(automatic.executionId)
          || !isNonEmptyString(automatic.model)
          || !['preparing', 'running', 'review', 'applied', 'discarded', 'interrupted'].includes(String(automatic.state))
          || !Number.isSafeInteger(automatic.pendingFileCount)
          || Number(automatic.pendingFileCount) < 0
          || !['pending', 'safe', 'rejected'].includes(String(automatic.safetyStatus))
          || (automatic.artifactId !== undefined && !isNonEmptyString(automatic.artifactId))) {
          push(issues, 'INVALID_SHAPE', `${path}.automaticExecution`, '自动执行元信息无效。')
        } else {
          if (run.executionMode !== 'local-agent') {
            push(issues, 'INVALID_STATE', `${path}.executionMode`, '自动执行任务必须使用本地代理模式。')
          }
          if (automatic.state === 'review' && (!automatic.artifactId || Number(automatic.pendingFileCount) < 1)) {
            push(issues, 'INVALID_STATE', `${path}.automaticExecution`, '待处理文件产物缺少安全句柄或文件数量。')
          }
          if (['applied', 'discarded', 'interrupted'].includes(String(automatic.state))
            && (automatic.artifactId !== undefined || automatic.pendingFileCount !== 0)) {
            push(issues, 'INVALID_STATE', `${path}.automaticExecution`, '已处理或中断的产物不能继续保留待应用句柄。')
          }
          if (['preparing', 'running'].includes(String(automatic.state)) && run.status !== 'running') {
            push(issues, 'INVALID_STATE', `${path}.automaticExecution.state`, '运行中的自动执行必须对应进行中任务。')
          }
          if (automatic.state === 'review' && run.status !== 'review') {
            push(issues, 'INVALID_STATE', `${path}.automaticExecution.state`, '待处理产物必须对应待验收任务。')
          }
          if (automatic.state === 'interrupted' && run.status !== 'needs-input') {
            push(issues, 'INVALID_STATE', `${path}.automaticExecution.state`, '中断执行必须等待用户确认。')
          }
        }
      } else if (run.executionMode === 'local-agent') {
        push(issues, 'INVALID_STATE', `${path}.automaticExecution`, '本地代理任务必须记录自动执行元信息。')
      }

      if (!isRecord(run.draft) || typeof run.draft.outputText !== 'string' || typeof run.draft.reviewNote !== 'string') {
        push(issues, 'INVALID_SHAPE', `${path}.draft`, '任务结果草稿结构无效。')
      } else {
        if (run.draft.outputText.length > MAX_TASK_RESULT_LENGTH) {
          push(issues, 'LIMIT_EXCEEDED', `${path}.draft.outputText`, `单个任务结果不能超过 ${MAX_TASK_RESULT_LENGTH} 个字符。`)
        }
        validatePathList(run.draft.changedFiles, `${path}.draft.changedFiles`, issues)
        validateVerification(run.draft.verification, expectedLabels(task), `${path}.draft.verification`, issues)
        validateHandoff(run.draft.handoff, run.draft.changedFiles, `${path}.draft.handoff`, issues)
      }

      if (run.dependencyHandoffs !== undefined) {
        if (!Array.isArray(run.dependencyHandoffs) || run.dependencyHandoffs.length > task.dependsOn.length) {
          push(issues, 'INVALID_SHAPE', `${path}.dependencyHandoffs`, '前置任务交接确认结构无效。')
        } else {
          const seenDependencies = new Set<string>()
          run.dependencyHandoffs.forEach((receipt, receiptIndex) => {
            const receiptPath = `${path}.dependencyHandoffs[${receiptIndex}]`
            if (!isRecord(receipt)
              || !task.dependsOn.includes(String(receipt.dependencyTaskId))
              || seenDependencies.has(String(receipt.dependencyTaskId))) {
              push(issues, 'TASK_MISMATCH', receiptPath, '交接确认必须对应唯一的直接前置任务。')
              return
            }
            seenDependencies.add(String(receipt.dependencyTaskId))
            validatePathList(receipt.authorizedReadPaths, `${receiptPath}.authorizedReadPaths`, issues)
            validatePathList(receipt.providedArtifactPaths, `${receiptPath}.providedArtifactPaths`, issues)
            if (receipt.providedToProviderId !== undefined && !isProviderId(receipt.providedToProviderId)) {
              push(issues, 'INVALID_SHAPE', `${receiptPath}.providedToProviderId`, '交接确认 Provider 无效。')
            }
          })
        }
      }

      if (run.result !== undefined) {
        if (!isRecord(run.result)) {
          push(issues, 'INVALID_SHAPE', `${path}.result`, '任务结果结构无效。')
        } else {
          if (run.result.taskId !== run.taskId || run.result.providerId !== run.assignedProviderId) {
            push(issues, 'TASK_MISMATCH', `${path}.result`, '任务结果与运行记录不一致。')
          }
          if (!isNonEmptyString(run.result.summary)) push(issues, 'INVALID_SHAPE', `${path}.result.summary`, '结果摘要不能为空。')
          if (run.result.outputText !== undefined && (typeof run.result.outputText !== 'string' || run.result.outputText.length > MAX_TASK_RESULT_LENGTH)) {
            push(issues, 'LIMIT_EXCEEDED', `${path}.result.outputText`, '任务结果正文无效或过长。')
          }
          if (run.result.reviewNote !== undefined && typeof run.result.reviewNote !== 'string') {
            push(issues, 'INVALID_SHAPE', `${path}.result.reviewNote`, '人工备注必须是字符串。')
          }
          validatePathList(run.result.changedFiles, `${path}.result.changedFiles`, issues)
          validateVerification(run.result.verification, expectedLabels(task), `${path}.result.verification`, issues)
          validateHandoff(run.result.handoff, run.result.changedFiles, `${path}.result.handoff`, issues)
          if (isRecord(run.draft) && run.draft.handoff !== undefined && run.result.handoff !== undefined
            && JSON.stringify(run.draft.handoff) !== JSON.stringify(run.result.handoff)) {
            push(issues, 'TASK_MISMATCH', `${path}.result.handoff`, '草稿与正式结果的交接信息必须保持一致。')
          }
        }
      }
    })
  }

  for (const task of plan.tasks) {
    const run = runById.get(task.id)
    if (!run) continue
    const dependenciesDone = task.dependsOn.every(dependencyId => runById.get(dependencyId)?.status === 'done')
    if (run.status === 'waiting' && dependenciesDone) push(issues, 'INVALID_STATE', `runs.${task.id}.status`, '依赖已完成的任务不应继续等待。')
    if (run.status === 'ready' && !dependenciesDone) push(issues, 'INVALID_STATE', `runs.${task.id}.status`, '依赖未完成的任务不能就绪。')
    if (['running', 'needs-input', 'review', 'done'].includes(String(run.status)) && !dependenciesDone) {
      push(issues, 'INVALID_STATE', `runs.${task.id}.status`, '依赖未完成的任务不能开始。')
    }
    if (['running', 'needs-input', 'review', 'done', 'failed'].includes(String(run.status)) && !isIsoDate(run.startedAt)) {
      push(issues, 'INVALID_STATE', `runs.${task.id}.startedAt`, '已开始的任务必须记录开始时间。')
    }
    if (['review', 'done'].includes(String(run.status)) && !isRecord(run.result)) {
      push(issues, 'INVALID_STATE', `runs.${task.id}.result`, '待验收或已完成任务必须包含结果。')
    }
    if (run.status === 'done') {
      if (!isIsoDate(run.completedAt)) push(issues, 'INVALID_STATE', `runs.${task.id}.completedAt`, '已完成任务必须记录完成时间。')
      const verification = isRecord(run.result) ? run.result.verification : undefined
      if (!Array.isArray(verification) || !verification.every(item => isRecord(item) && item.status === 'passed')) {
        push(issues, 'INVALID_STATE', `runs.${task.id}.result.verification`, '任务完成前所有验收项必须通过。')
      }
    }
    if (Array.isArray(run.dependencyHandoffs)) {
      for (const receipt of run.dependencyHandoffs) {
        if (!isRecord(receipt)) continue
        const dependencyRun = runById.get(String(receipt.dependencyTaskId))
        const handoff = isRecord(dependencyRun?.result) && isRecord(dependencyRun.result.handoff)
          ? dependencyRun.result.handoff
          : undefined
        const artifacts = Array.isArray(handoff?.artifacts)
          ? new Set(handoff.artifacts.flatMap(artifact => isRecord(artifact) && typeof artifact.path === 'string' ? [artifact.path] : []))
          : new Set<string>()
        for (const field of ['authorizedReadPaths', 'providedArtifactPaths'] as const) {
          const paths = Array.isArray(receipt[field]) ? receipt[field] : []
          if (paths.some(path => typeof path !== 'string' || !artifacts.has(path))) {
            push(issues, 'TASK_MISMATCH', `runs.${task.id}.dependencyHandoffs.${field}`, '交接确认只能引用直接前置任务声明的文件。')
          }
        }
      }
    }
  }

  validateVerification(value.finalVerification, plan.finalAcceptanceChecks, 'finalVerification', issues)
  const allTasksDone = plan.tasks.every(task => runById.get(task.id)?.status === 'done')
  const finalPassed = Array.isArray(value.finalVerification)
    && value.finalVerification.every(item => isRecord(item) && item.status === 'passed')
  if (value.completedAt !== undefined && (!allTasksDone || !finalPassed)) {
    push(issues, 'INVALID_STATE', 'completedAt', '只有所有任务和最终验收通过后才能完成会话。')
  }

  return issues.length === 0
    ? { ok: true, session: value as unknown as TaskSessionV1 }
    : { ok: false, issues }
}

export const isTaskSession = (value: unknown): value is TaskSessionV1 => validateTaskSession(value).ok
