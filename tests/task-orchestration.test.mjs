import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTs } from './load-ts.mjs'

const {
  MAX_TASK_PLAN_TASKS,
  isTaskPlan,
  validateTaskPlan,
} = await loadTs('../src/orchestration/taskPlanValidation.ts')

const task = (overrides = {}) => ({
  id: 'task-1',
  title: '分析项目',
  description: '阅读项目结构并记录现状。',
  dependsOn: [],
  recommendedProviderId: 'deepseek',
  executionMode: 'manual',
  prompt: '请分析项目结构并给出报告。',
  files: {
    inputs: [
      { kind: 'attachment', name: 'requirements.pdf', type: 'application/pdf', size: 1024 },
      { kind: 'workspace', path: 'src/App.tsx' },
    ],
    allowedWritePaths: [],
    forbiddenPaths: ['src/App.tsx'],
    outputPaths: ['reports/analysis.md'],
  },
  expectedDeliverables: ['项目分析报告'],
  acceptanceChecks: ['报告包含主要模块关系'],
  ...overrides,
})

const plan = (overrides = {}) => ({
  schemaVersion: 1,
  id: 'plan-1',
  title: '项目分析计划',
  goal: '完成项目分析并输出报告。',
  assumptions: ['只读取文件元信息和指定工作区文件。'],
  tasks: [task()],
  finalAcceptanceChecks: ['所有任务均完成验收'],
  ...overrides,
})

const issueCodes = value => {
  const result = validateTaskPlan(value)
  assert.equal(result.ok, false)
  return result.issues.map(issue => issue.code)
}

test('accepts a valid serial plan with attachment and workspace references', () => {
  const value = plan({
    tasks: [
      task(),
      task({
        id: 'task-2',
        title: '实现功能',
        description: '根据分析结果实现功能。',
        dependsOn: ['task-1'],
        recommendedProviderId: 'codex',
        executionMode: 'local-agent',
        files: {
          inputs: [{ kind: 'workspace', path: 'src/task-analysis/TaskAnalyzer.ts' }],
          allowedWritePaths: ['src/task-analysis'],
          forbiddenPaths: ['src/App.tsx'],
          outputPaths: ['src/task-analysis/NewAnalyzer.ts'],
        },
      }),
    ],
  })

  const result = validateTaskPlan(value)
  assert.equal(result.ok, true)
  assert.equal(result.plan, value)
  assert.equal(isTaskPlan(value), true)
})

test('accepts parallel roots and an extensible custom provider', () => {
  const value = plan({
    tasks: [
      task({ id: 'research', recommendedProviderId: 'doubao' }),
      task({ id: 'draft', recommendedProviderId: 'custom:team-model' }),
      task({ id: 'review', dependsOn: ['research', 'draft'], recommendedProviderId: 'local' }),
    ],
  })
  assert.equal(validateTaskPlan(value).ok, true)
})

test('rejects unsupported versions and invalid provider IDs', () => {
  const value = plan({
    schemaVersion: 2,
    tasks: [task({ recommendedProviderId: 'custom:Bad Provider' })],
  })
  const codes = issueCodes(value)
  assert.ok(codes.includes('UNSUPPORTED_VERSION'))
  assert.ok(codes.includes('INVALID_PROVIDER_ID'))
})

test('rejects duplicate, unknown and self dependencies', () => {
  const duplicate = plan({ tasks: [task(), task()] })
  assert.ok(issueCodes(duplicate).includes('DUPLICATE_TASK_ID'))

  const unknown = plan({ tasks: [task({ dependsOn: ['missing'] })] })
  assert.ok(issueCodes(unknown).includes('UNKNOWN_DEPENDENCY'))

  const self = plan({ tasks: [task({ dependsOn: ['task-1'] })] })
  assert.ok(issueCodes(self).includes('SELF_DEPENDENCY'))

  const repeatedDependency = plan({
    tasks: [
      task(),
      task({ id: 'task-2', dependsOn: ['task-1', 'task-1'] }),
    ],
  })
  assert.ok(issueCodes(repeatedDependency).includes('DUPLICATE_DEPENDENCY'))
})

test('rejects cyclic dependencies', () => {
  const value = plan({
    tasks: [
      task({ id: 'task-a', dependsOn: ['task-b'] }),
      task({ id: 'task-b', dependsOn: ['task-a'] }),
    ],
  })
  assert.ok(issueCodes(value).includes('CYCLIC_DEPENDENCY'))
})

test('rejects unsafe workspace paths in every path-bearing location', () => {
  const unsafePaths = [
    'C:\\secret.txt',
    'C:secret.txt',
    '/etc/passwd',
    '\\\\server\\share',
    '../outside.txt',
    'src/../../outside.txt',
    'file://secret.txt',
    `src/bad\0name.ts`,
  ]

  for (const unsafePath of unsafePaths) {
    const value = plan({
      tasks: [task({
        files: {
          inputs: [{ kind: 'workspace', path: unsafePath }],
          allowedWritePaths: [unsafePath],
          forbiddenPaths: [],
          outputPaths: [],
        },
      })],
    })
    assert.ok(issueCodes(value).includes('INVALID_PATH'), unsafePath)
  }
})

test('rejects malformed attachment metadata', () => {
  const invalidAttachments = [
    { kind: 'attachment', name: '', type: 'text/plain', size: 1 },
    { kind: 'attachment', name: 'file.txt', type: '', size: 1 },
    { kind: 'attachment', name: 'file.txt', type: 'text/plain', size: -1 },
    { kind: 'attachment', name: 'file.txt', type: 'text/plain', size: Number.NaN },
  ]

  for (const attachment of invalidAttachments) {
    const value = plan({
      tasks: [task({ files: { ...task().files, inputs: [attachment] } })],
    })
    assert.ok(issueCodes(value).includes('INVALID_SHAPE'))
  }
})

test('rejects plans over the task limit', () => {
  const tasks = Array.from({ length: MAX_TASK_PLAN_TASKS + 1 }, (_, index) => task({
    id: `task-${index + 1}`,
  }))
  assert.ok(issueCodes(plan({ tasks })).includes('LIMIT_EXCEEDED'))
})

test('validation does not mutate its input', () => {
  const value = plan()
  const before = structuredClone(value)
  validateTaskPlan(value)
  assert.deepEqual(value, before)
})

test('malformed unknown JSON returns issues instead of throwing', () => {
  const values = [
    null,
    [],
    plan({ tasks: [42] }),
    plan({ tasks: [{ ...task(), dependsOn: null }] }),
    plan({ tasks: [{ ...task(), dependsOn: [7] }] }),
    plan({ tasks: [{ ...task(), files: null }] }),
  ]

  for (const value of values) {
    assert.doesNotThrow(() => validateTaskPlan(value))
    assert.equal(validateTaskPlan(value).ok, false)
  }
})

test('rejects missing required task content and acceptance criteria', () => {
  const value = plan({
    tasks: [task({ prompt: '  ', expectedDeliverables: [], acceptanceChecks: [] })],
    finalAcceptanceChecks: [],
  })
  assert.equal(validateTaskPlan(value).ok, false)
  assert.equal(isTaskPlan(value), false)
})
