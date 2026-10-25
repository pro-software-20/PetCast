import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTs } from './load-ts.mjs'

const {
  applyWorkspacePathScope,
  getTaskWorkspacePathScope,
  MAX_TASK_SCOPE_PATHS,
  normalizeTaskFileScope,
  normalizeWorkspacePath,
  pathContains,
  validateTaskPathScope,
  workspacePathScopesEqual,
} = await loadTs('../src/orchestration/taskPathScope.ts')

const scope = overrides => ({
  inputs: [],
  allowedWritePaths: [],
  forbiddenPaths: [],
  outputPaths: [],
  ...overrides,
})

test('normalizes safe relative paths and removes duplicates without mutating input', () => {
  const original = scope({
    inputs: [
      { kind: 'attachment', name: 'note.txt', type: 'text/plain', size: 2 },
      { kind: 'workspace', path: './src\\App.tsx' },
    ],
    allowedWritePaths: ['./src', 'src'],
    forbiddenPaths: ['src/private'],
    outputPaths: ['src//result.ts'],
  })
  const before = structuredClone(original)
  const normalized = normalizeTaskFileScope(original)
  assert.deepEqual(original, before)
  assert.deepEqual(normalized.allowedWritePaths, ['src'])
  assert.deepEqual(normalized.outputPaths, ['src/result.ts'])
  assert.deepEqual(normalized.inputs, [{ kind: 'attachment', name: 'note.txt', type: 'text/plain', size: 2 }])
  assert.deepEqual(normalized.readPaths, ['src/App.tsx'])
})

test('rejects absolute, traversal, empty and malformed workspace paths', () => {
  for (const value of ['', '.', '../secret', 'src/../secret', '/root', 'C:/root', 'a\0b']) {
    assert.equal(normalizeWorkspacePath(value), null, value)
  }
  assert.equal(normalizeWorkspacePath('src\\nested\\file.ts'), 'src/nested/file.ts')
})

test('forbidden subpaths override broad allowed paths and outputs need authorization', () => {
  assert.equal(pathContains('src', 'src/private/a.ts'), true)
  const issues = validateTaskPathScope(scope({
    allowedWritePaths: ['src'],
    forbiddenPaths: ['src/private'],
    outputPaths: ['src/private/result.ts', 'docs/result.md'],
  }), { requireAuthorizedOutputs: true })
  assert.equal(issues.length, 2)
  assert.ok(issues.some(issue => issue.path === 'outputPaths[0]'))
  assert.ok(issues.some(issue => issue.path === 'outputPaths[1]'))
})

test('rejects duplicates and path list limits', () => {
  const duplicate = validateTaskPathScope(scope({ allowedWritePaths: ['src', 'src'] }))
  assert.ok(duplicate.some(issue => issue.path === 'allowedWritePaths[1]'))
  const oversized = validateTaskPathScope(scope({
    outputPaths: Array.from({ length: MAX_TASK_SCOPE_PATHS + 1 }, (_, index) => `out/${index}.txt`),
  }))
  assert.ok(oversized.some(issue => issue.path === 'outputPaths'))
})

test('directory read scopes cover descendants and preserve attachments when applied', () => {
  const taskScope = {
    inputs: [{ kind: 'attachment', name: 'brief.pdf', type: 'application/pdf', size: 10 }],
    allowedWritePaths: [], forbiddenPaths: [], outputPaths: [],
  }
  const workspaceScope = {
    readPaths: ['src'],
    allowedWritePaths: ['src/generated'],
    forbiddenPaths: ['src/private'],
    outputPaths: ['src/generated/result.ts'],
  }
  const applied = applyWorkspacePathScope(taskScope, workspaceScope)
  assert.deepEqual(applied.inputs, taskScope.inputs)
  assert.deepEqual(getTaskWorkspacePathScope(applied), workspaceScope)
  assert.equal(pathContains(applied.readPaths[0], 'src/components/App.tsx'), true)
  assert.equal(workspacePathScopesEqual(getTaskWorkspacePathScope(applied), workspaceScope), true)
})
