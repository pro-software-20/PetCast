export const SOFTWARE_OPERATION_ERROR_CODES = [
  'INVALID_REQUEST',
  'BUSY',
  'MANUAL_CONTROL',
  'TARGET_NOT_FOUND',
  'TARGET_CHANGED',
  'TIMEOUT',
  'CANCELLED',
  'ADAPTER_FAILED',
] as const

export type SoftwareOperationErrorCode = (typeof SOFTWARE_OPERATION_ERROR_CODES)[number]

export interface SoftwareTargetExpectation {
  adapterId: string
  applicationId: string
  windowHint?: string
}

export interface SoftwareOperationRequest {
  operationId: string
  target: SoftwareTargetExpectation
  steps: unknown[]
  timeoutMs?: number
}

export interface SoftwareOperationEvidence {
  kind: string
  summary: string
}

export type SoftwareOperationOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; code: SoftwareOperationErrorCode; message: string }

export interface SoftwareOperationResult {
  operationId: string
  completedSteps: number
  evidence: SoftwareOperationEvidence[]
}

export interface SoftwareOperationEvent {
  operationId: string
  stage: 'checking' | 'running' | 'verifying' | 'completed' | 'interrupted'
  stepIndex: number | null
  message: string
  code?: SoftwareOperationErrorCode
}

export interface SoftwareOperationAdapter<TStep = unknown, TVerifiedTarget = unknown, TStepResult = unknown> {
  readonly id: string
  parseStep(value: unknown): TStep
  verifyTarget(
    expectation: SoftwareTargetExpectation,
    stepIndex: number,
    signal: AbortSignal,
  ): Promise<TVerifiedTarget>
  executeStep(step: TStep, target: TVerifiedTarget, signal: AbortSignal): Promise<TStepResult>
  verifyStep(
    step: TStep,
    target: TVerifiedTarget,
    result: TStepResult,
    signal: AbortSignal,
  ): Promise<SoftwareOperationEvidence>
  stop?(target: TVerifiedTarget | undefined): Promise<void> | void
}

export interface SoftwareOperationCoordinatorOptions {
  minTimeoutMs?: number
  defaultTimeoutMs?: number
  maxTimeoutMs?: number
}

interface ActiveOperation<TTarget = unknown> {
  operationId: string
  controller: AbortController
  adapter: SoftwareOperationAdapter<unknown, TTarget, unknown>
  lastTarget?: TTarget
}

interface ValidatedSoftwareOperation<TStep> {
  request: SoftwareOperationRequest
  steps: TStep[]
  timeoutMs: number
}

const ID = /^[A-Za-z0-9._:-]{1,120}$/
const MAX_STEPS = 40
const MAX_HINT = 160

export const SOFTWARE_OPERATION_MESSAGES: Record<SoftwareOperationErrorCode, string> = {
  INVALID_REQUEST: '软件操作请求无效。',
  BUSY: '已有软件操作正在进行，请等待、停止或人工接管。',
  MANUAL_CONTROL: '当前由用户人工接管，自动操作保持暂停。',
  TARGET_NOT_FOUND: '未找到已确认的目标软件窗口。',
  TARGET_CHANGED: '目标窗口或页面已变化，自动操作已停止并等待重新确认。',
  TIMEOUT: '软件操作超时，已停止本次任务。',
  CANCELLED: '软件操作已停止。',
  ADAPTER_FAILED: '软件操作未能完成，请人工检查目标软件状态。',
}

export class SoftwareOperationError extends Error {
  constructor(readonly code: SoftwareOperationErrorCode) {
    super(SOFTWARE_OPERATION_MESSAGES[code])
    this.name = 'SoftwareOperationError'
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
)

const hasOnlyKeys = (value: Record<string, unknown>, allowed: readonly string[]) => (
  Object.keys(value).every(key => allowed.includes(key))
)

const validHint = (value: unknown) => value === undefined || (
  typeof value === 'string' && value.length > 0 && value.length <= MAX_HINT
  && value === value.trim() && !/[\u0000-\u001f]/.test(value)
)

const cloneExpectation = (target: SoftwareTargetExpectation): SoftwareTargetExpectation => ({
  adapterId: target.adapterId,
  applicationId: target.applicationId,
  ...(target.windowHint ? { windowHint: target.windowHint } : {}),
})

const normalizeEvidence = (value: SoftwareOperationEvidence): SoftwareOperationEvidence => {
  if (!isRecord(value) || !hasOnlyKeys(value, ['kind', 'summary'])
    || typeof value.kind !== 'string' || !ID.test(value.kind)
    || typeof value.summary !== 'string' || !value.summary.trim()
    || value.summary.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value.summary)) {
    throw new SoftwareOperationError('ADAPTER_FAILED')
  }
  return { kind: value.kind, summary: value.summary.trim() }
}

const signalCode = (signal: AbortSignal): SoftwareOperationErrorCode => {
  const reason = signal.reason
  if (isRecord(reason) && reason.code === 'TIMEOUT') return 'TIMEOUT'
  if (isRecord(reason) && reason.code === 'MANUAL_CONTROL') return 'MANUAL_CONTROL'
  return 'CANCELLED'
}

const errorCode = (error: unknown, signal: AbortSignal): SoftwareOperationErrorCode => {
  if (signal.aborted) return signalCode(signal)
  return error instanceof SoftwareOperationError ? error.code : 'ADAPTER_FAILED'
}

const abortable = async <T>(signal: AbortSignal, action: Promise<T>): Promise<T> => {
  if (signal.aborted) throw new SoftwareOperationError(signalCode(signal))
  return await new Promise<T>((resolve, reject) => {
    const aborted = () => reject(new SoftwareOperationError(signalCode(signal)))
    signal.addEventListener('abort', aborted, { once: true })
    action.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted))
  })
}

export class SoftwareOperationCoordinator {
  private active?: ActiveOperation
  private manualControl = false
  private disposed = false
  private readonly minTimeoutMs: number
  private readonly defaultTimeoutMs: number
  private readonly maxTimeoutMs: number

  constructor(
    private readonly emit: (event: SoftwareOperationEvent) => void,
    options: SoftwareOperationCoordinatorOptions = {},
  ) {
    this.minTimeoutMs = options.minTimeoutMs ?? 1_000
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 2 * 60_000
    this.maxTimeoutMs = options.maxTimeoutMs ?? 10 * 60_000
    if (!Number.isInteger(this.minTimeoutMs) || !Number.isInteger(this.defaultTimeoutMs)
      || !Number.isInteger(this.maxTimeoutMs) || this.minTimeoutMs < 1
      || this.defaultTimeoutMs < this.minTimeoutMs || this.defaultTimeoutMs > this.maxTimeoutMs) {
      throw new Error('INVALID_SOFTWARE_OPERATION_LIMITS')
    }
  }

  private fail<T>(code: SoftwareOperationErrorCode): SoftwareOperationOutcome<T> {
    return { ok: false, code, message: SOFTWARE_OPERATION_MESSAGES[code] }
  }

  private validate<TStep>(
    adapter: SoftwareOperationAdapter<TStep, unknown, unknown>,
    value: unknown,
  ): ValidatedSoftwareOperation<TStep> {
    if (!isRecord(value) || !hasOnlyKeys(value, ['operationId', 'target', 'steps', 'timeoutMs'])
      || typeof value.operationId !== 'string' || !ID.test(value.operationId)
      || !isRecord(value.target) || !hasOnlyKeys(value.target, ['adapterId', 'applicationId', 'windowHint'])
      || typeof value.target.adapterId !== 'string' || !ID.test(value.target.adapterId)
      || typeof value.target.applicationId !== 'string' || !ID.test(value.target.applicationId)
      || !validHint(value.target.windowHint) || value.target.adapterId !== adapter.id
      || !Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > MAX_STEPS) {
      throw new SoftwareOperationError('INVALID_REQUEST')
    }
    const timeoutMs = value.timeoutMs === undefined ? this.defaultTimeoutMs : value.timeoutMs
    if (!Number.isInteger(timeoutMs) || (timeoutMs as number) < this.minTimeoutMs
      || (timeoutMs as number) > this.maxTimeoutMs) throw new SoftwareOperationError('INVALID_REQUEST')
    let steps: TStep[]
    try { steps = value.steps.map(step => adapter.parseStep(step)) }
    catch { throw new SoftwareOperationError('INVALID_REQUEST') }
    const target: SoftwareTargetExpectation = {
      adapterId: value.target.adapterId,
      applicationId: value.target.applicationId,
      ...(value.target.windowHint ? { windowHint: value.target.windowHint as string } : {}),
    }
    return {
      request: {
        operationId: value.operationId,
        target,
        steps: [...value.steps],
        timeoutMs: timeoutMs as number,
      },
      steps,
      timeoutMs: timeoutMs as number,
    }
  }

  private stopAdapter(active: ActiveOperation) {
    try { void Promise.resolve(active.adapter.stop?.(active.lastTarget)).catch(() => undefined) }
    catch { /* Stopping remains best-effort after the abort signal is raised. */ }
  }

  private abortActive(code: 'CANCELLED' | 'MANUAL_CONTROL') {
    const active = this.active
    if (!active || active.controller.signal.aborted) return false
    active.controller.abort({ code })
    this.stopAdapter(active)
    return true
  }

  async run<TStep, TTarget, TStepResult>(
    adapter: SoftwareOperationAdapter<TStep, TTarget, TStepResult>,
    value: unknown,
  ): Promise<SoftwareOperationOutcome<SoftwareOperationResult>> {
    if (this.disposed) return this.fail('CANCELLED')
    if (this.manualControl) return this.fail('MANUAL_CONTROL')
    if (this.active) return this.fail('BUSY')

    let validated: ValidatedSoftwareOperation<TStep>
    try { validated = this.validate(adapter as SoftwareOperationAdapter<TStep, unknown, unknown>, value) }
    catch (error) {
      return this.fail(error instanceof SoftwareOperationError ? error.code : 'INVALID_REQUEST')
    }

    const { request, steps, timeoutMs } = validated
    const controller = new AbortController()
    const active: ActiveOperation<TTarget> = {
      operationId: request.operationId,
      controller,
      adapter: adapter as SoftwareOperationAdapter<unknown, TTarget, unknown>,
    }
    this.active = active as ActiveOperation
    const timer = setTimeout(() => {
      if (this.active === active && !controller.signal.aborted) {
        controller.abort({ code: 'TIMEOUT' })
        this.stopAdapter(active as ActiveOperation)
      }
    }, timeoutMs)
    timer.unref?.()

    const evidence: SoftwareOperationEvidence[] = []
    let completedSteps = 0
    try {
      for (let index = 0; index < steps.length; index += 1) {
        if (controller.signal.aborted) throw new SoftwareOperationError(signalCode(controller.signal))
        this.emit({
          operationId: request.operationId,
          stage: 'checking',
          stepIndex: index,
          message: '正在重新核对目标软件窗口和页面。',
        })
        const target = await abortable(
          controller.signal,
          adapter.verifyTarget(cloneExpectation(request.target), index, controller.signal),
        )
        if (target === undefined || target === null) throw new SoftwareOperationError('TARGET_NOT_FOUND')
        active.lastTarget = target
        if (controller.signal.aborted) throw new SoftwareOperationError(signalCode(controller.signal))
        this.emit({
          operationId: request.operationId,
          stage: 'running',
          stepIndex: index,
          message: '目标已确认，正在执行当前步骤。',
        })
        const result = await abortable(
          controller.signal,
          adapter.executeStep(steps[index], target, controller.signal),
        )
        this.emit({
          operationId: request.operationId,
          stage: 'verifying',
          stepIndex: index,
          message: '正在核对当前步骤的实际结果。',
        })
        const checked = await abortable(
          controller.signal,
          adapter.verifyStep(steps[index], target, result, controller.signal),
        )
        evidence.push(normalizeEvidence(checked))
        completedSteps += 1
      }
      if (controller.signal.aborted) throw new SoftwareOperationError(signalCode(controller.signal))
      this.emit({
        operationId: request.operationId,
        stage: 'completed',
        stepIndex: null,
        message: '软件操作已完成，并已核对每一步结果。',
      })
      return { ok: true, value: { operationId: request.operationId, completedSteps, evidence } }
    } catch (error) {
      const code = errorCode(error, controller.signal)
      this.emit({
        operationId: request.operationId,
        stage: 'interrupted',
        stepIndex: completedSteps < steps.length ? completedSteps : null,
        code,
        message: SOFTWARE_OPERATION_MESSAGES[code],
      })
      return this.fail(code)
    } finally {
      clearTimeout(timer)
      if (this.active === active) this.active = undefined
    }
  }

  stop(operationId: string): SoftwareOperationOutcome<null> {
    if (!ID.test(operationId) || this.active?.operationId !== operationId) return this.fail('INVALID_REQUEST')
    this.abortActive('CANCELLED')
    return { ok: true, value: null }
  }

  takeManualControl(): SoftwareOperationOutcome<null> {
    this.manualControl = true
    this.abortActive('MANUAL_CONTROL')
    return { ok: true, value: null }
  }

  releaseManualControl(): SoftwareOperationOutcome<null> {
    if (this.disposed) return this.fail('CANCELLED')
    this.manualControl = false
    return { ok: true, value: null }
  }

  status() {
    return {
      mode: this.manualControl ? 'manual' as const : 'automatic' as const,
      activeOperationId: this.active?.operationId ?? null,
    }
  }

  dispose() {
    this.disposed = true
    this.manualControl = true
    this.abortActive('CANCELLED')
  }
}
