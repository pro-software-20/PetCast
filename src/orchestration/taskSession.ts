import { validateTaskSession } from './taskSessionValidation'
import type {
  ProviderId,
  TaskPlan,
  TaskResultDraft,
  TaskRunRecord,
  TaskSessionV1,
  VerificationStatus,
} from '../types/taskOrchestration'
import type { TaskAnalysisInput, TaskAnalysisResult } from '../types/taskAnalysis'

export interface CreateTaskSessionInput {
  analysisInput: TaskAnalysisInput
  analysisResult: TaskAnalysisResult
  plan: TaskPlan
}

export type TaskSessionAction =
  | { type: 'assign-provider'; taskId: string; providerId: ProviderId }
  | { type: 'set-task-dependencies'; taskId: string; dependsOn: string[] }
  | { type: 'start'; taskId: string }
  | { type: 'update-draft'; taskId: string; draft: Partial<TaskResultDraft> }
  | { type: 'needs-input'; taskId: string; message: string }
  | { type: 'resume'; taskId: string }
  | { type: 'submit-result'; taskId: string }
  | { type: 'accept'; taskId: string }
  | { type: 'request-changes'; taskId: string; message?: string }
  | { type: 'fail'; taskId: string; message: string }
  | { type: 'cancel'; taskId: string; message?: string }
  | { type: 'retry'; taskId: string }
  | { type: 'set-final-verification'; index: number; status: VerificationStatus; details?: string }

export type TaskSessionUpdateErrorCode =
  | 'INVALID_SESSION'
  | 'TASK_NOT_FOUND'
  | 'INVALID_TRANSITION'
  | 'INVALID_DATA'

export type TaskSessionUpdateOutcome =
  | { ok: true; session: TaskSessionV1 }
  | { ok: false; code: TaskSessionUpdateErrorCode; message: string }

const clone = <T>(value: T): T => structuredClone(value)

const hashText = (text: string) => {
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

const emptyDraft = (checks: string[]): TaskResultDraft => ({
  outputText: '',
  changedFiles: [],
  verification: checks.map(label => ({ label, status: 'not-run' })),
  reviewNote: '',
})

const summarize = (text: string) => {
  const firstParagraph = text.trim().split(/\n\s*\n|\r?\n/)[0]?.replace(/\s+/g, ' ').trim() ?? ''
  return firstParagraph.length > 300 ? `${firstParagraph.slice(0, 299)}…` : firstParagraph
}

const normalizePaths = (paths: string[]) => [...new Set(paths.map(path => path.trim()).filter(Boolean))]

const refreshReadyTasks = (session: TaskSessionV1) => {
  const statusById = new Map(session.runs.map(run => [run.taskId, run.status]))
  session.runs.forEach((run) => {
    if (run.status !== 'waiting') return
    const task = session.plan.tasks.find(candidate => candidate.id === run.taskId)
    if (task?.dependsOn.every(dependencyId => statusById.get(dependencyId) === 'done')) {
      run.status = 'ready'
    }
  })
}

const invalidTransition = (message: string): TaskSessionUpdateOutcome => ({
  ok: false,
  code: 'INVALID_TRANSITION',
  message,
})

export const canEditTaskDependencies = (session: TaskSessionV1) => session.runs.every(run => (
  ['waiting', 'ready'].includes(run.status)
  && run.attempt === 0
  && !run.startedAt
  && !run.completedAt
  && !run.result
))

const refreshPreExecutionStatuses = (session: TaskSessionV1) => {
  const statusById = new Map(session.runs.map(run => [run.taskId, run.status]))
  session.runs.forEach((run) => {
    const task = session.plan.tasks.find(candidate => candidate.id === run.taskId)
    run.status = task?.dependsOn.every(dependencyId => statusById.get(dependencyId) === 'done')
      ? 'ready'
      : 'waiting'
  })
}

export function createTaskSession(
  input: CreateTaskSessionInput,
  now = new Date().toISOString(),
): TaskSessionUpdateOutcome {
  const session: TaskSessionV1 = {
    schemaVersion: 1,
    id: `session-${hashText(`${input.plan.id}\0${now}`)}`,
    createdAt: now,
    updatedAt: now,
    analysisInput: clone(input.analysisInput),
    analysisResult: clone(input.analysisResult),
    plan: clone(input.plan),
    runs: input.plan.tasks.map((task): TaskRunRecord => ({
      taskId: task.id,
      status: task.dependsOn.length === 0 ? 'ready' : 'waiting',
      assignedProviderId: task.recommendedProviderId,
      executionMode: 'manual',
      attempt: 0,
      draft: emptyDraft(task.acceptanceChecks),
    })),
    finalVerification: input.plan.finalAcceptanceChecks.map(label => ({ label, status: 'not-run' })),
  }
  const validation = validateTaskSession(session)
  return validation.ok
    ? { ok: true, session }
    : { ok: false, code: 'INVALID_DATA', message: '生成的任务会话未通过安全校验。' }
}

export function updateTaskSession(
  current: TaskSessionV1,
  action: TaskSessionAction,
  now = new Date().toISOString(),
): TaskSessionUpdateOutcome {
  if (!validateTaskSession(current).ok) {
    return { ok: false, code: 'INVALID_SESSION', message: '当前任务会话无效，无法更新。' }
  }
  if (current.completedAt) return invalidTransition('已完成的任务会话不能继续修改。')

  const session = clone(current)
  if (action.type === 'set-final-verification') {
    if (!session.runs.every(run => run.status === 'done')) {
      return invalidTransition('所有任务完成后才能进行最终验收。')
    }
    const verification = session.finalVerification[action.index]
    if (!verification) return { ok: false, code: 'INVALID_DATA', message: '最终验收项不存在。' }
    verification.status = action.status
    verification.details = action.details?.trim() || undefined
    session.updatedAt = now
    if (session.finalVerification.every(item => item.status === 'passed')) session.completedAt = now
  } else {
    const run = session.runs.find(candidate => candidate.taskId === action.taskId)
    const task = session.plan.tasks.find(candidate => candidate.id === action.taskId)
    if (!run || !task) return { ok: false, code: 'TASK_NOT_FOUND', message: '任务不存在。' }

    switch (action.type) {
      case 'set-task-dependencies': {
        if (!canEditTaskDependencies(session)) return invalidTransition('已有任务开始后不能修改依赖关系，请新建任务后重新调整。')
        if (!Array.isArray(action.dependsOn) || action.dependsOn.some(dependency => typeof dependency !== 'string')) {
          return { ok: false, code: 'INVALID_DATA', message: '前置任务列表无效。' }
        }
        if (new Set(action.dependsOn).size !== action.dependsOn.length) {
          return { ok: false, code: 'INVALID_DATA', message: '前置任务不能重复。' }
        }
        const taskIndex = session.plan.tasks.findIndex(candidate => candidate.id === task.id)
        const invalidDependency = action.dependsOn.find((dependencyId) => {
          const dependencyIndex = session.plan.tasks.findIndex(candidate => candidate.id === dependencyId)
          return dependencyIndex < 0 || dependencyIndex >= taskIndex
        })
        if (invalidDependency) {
          return { ok: false, code: 'INVALID_DATA', message: '只能选择当前任务之前的任务作为前置任务。' }
        }
        task.dependsOn = [...action.dependsOn]
        refreshPreExecutionStatuses(session)
        break
      }
      case 'assign-provider':
        if (!['waiting', 'ready'].includes(run.status)) return invalidTransition('任务开始后不能切换 AI。')
        run.assignedProviderId = action.providerId
        break
      case 'start':
        if (run.status !== 'ready') return invalidTransition('只有已就绪任务可以开始。')
        run.status = 'running'
        run.startedAt = now
        run.completedAt = undefined
        run.statusMessage = undefined
        run.attempt += 1
        break
      case 'update-draft':
        if (!['running', 'needs-input'].includes(run.status)) return invalidTransition('只有进行中或等待补充信息的任务可以编辑结果。')
        run.draft = {
          outputText: action.draft.outputText ?? run.draft.outputText,
          changedFiles: action.draft.changedFiles ? normalizePaths(action.draft.changedFiles) : run.draft.changedFiles,
          verification: action.draft.verification ? clone(action.draft.verification) : run.draft.verification,
          reviewNote: action.draft.reviewNote ?? run.draft.reviewNote,
        }
        break
      case 'needs-input':
        if (run.status !== 'running') return invalidTransition('只有进行中的任务可以等待补充信息。')
        run.status = 'needs-input'
        run.statusMessage = action.message.trim() || '需要补充信息。'
        break
      case 'resume':
        if (run.status !== 'needs-input') return invalidTransition('当前任务不处于等待补充信息状态。')
        run.status = 'running'
        run.statusMessage = undefined
        break
      case 'submit-result': {
        if (run.status !== 'running') return invalidTransition('只有进行中的任务可以提交结果。')
        if (!run.draft.outputText.trim()) return { ok: false, code: 'INVALID_DATA', message: '请先粘贴 AI 返回结果。' }
        const summary = summarize(run.draft.outputText)
        if (!summary) return { ok: false, code: 'INVALID_DATA', message: '任务结果不能为空。' }
        run.result = {
          taskId: run.taskId,
          providerId: run.assignedProviderId,
          summary,
          outputText: run.draft.outputText,
          changedFiles: normalizePaths(run.draft.changedFiles),
          verification: clone(run.draft.verification),
          reviewNote: run.draft.reviewNote.trim() || undefined,
        }
        run.status = 'review'
        run.statusMessage = undefined
        break
      }
      case 'accept':
        if (run.status !== 'review' || !run.result) return invalidTransition('只有待验收任务可以确认完成。')
        if (!run.result.verification.every(item => item.status === 'passed')) {
          return invalidTransition('所有任务验收项通过后才能确认完成。')
        }
        run.status = 'done'
        run.completedAt = now
        run.statusMessage = undefined
        break
      case 'request-changes':
        if (run.status !== 'review') return invalidTransition('只有待验收任务可以退回修改。')
        run.status = 'running'
        run.result = undefined
        run.statusMessage = action.message?.trim() || '结果已退回修改。'
        break
      case 'fail':
        if (!['running', 'needs-input', 'review'].includes(run.status)) return invalidTransition('当前任务不能标记失败。')
        run.status = 'failed'
        run.statusMessage = action.message.trim() || '任务执行失败。'
        break
      case 'cancel':
        if (!['waiting', 'ready', 'running', 'needs-input', 'review'].includes(run.status)) return invalidTransition('当前任务不能取消。')
        run.status = 'cancelled'
        run.statusMessage = action.message?.trim() || '任务已取消。'
        break
      case 'retry': {
        if (!['failed', 'cancelled'].includes(run.status)) return invalidTransition('只有失败或已取消任务可以重试。')
        const statusById = new Map(session.runs.map(candidate => [candidate.taskId, candidate.status]))
        run.status = task.dependsOn.every(dependencyId => statusById.get(dependencyId) === 'done') ? 'ready' : 'waiting'
        run.result = undefined
        run.startedAt = undefined
        run.completedAt = undefined
        run.statusMessage = undefined
        break
      }
    }
    session.updatedAt = now
    refreshReadyTasks(session)
  }

  const validation = validateTaskSession(session)
  return validation.ok
    ? { ok: true, session }
    : { ok: false, code: 'INVALID_DATA', message: '更新后的任务会话未通过安全校验。' }
}
