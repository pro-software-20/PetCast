import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTs } from './load-ts.mjs'

const { buildWorkspaceTree, filterWorkspaceTree } = await loadTs('../src/orchestration/workspaceTree.ts')

const entries = [
  { path: 'README.md', kind: 'file', size: 10 },
  { path: 'docs', kind: 'directory' },
  { path: 'docs/guide.md', kind: 'file', size: 20 },
  { path: 'src', kind: 'directory' },
  { path: 'src/components', kind: 'directory' },
  { path: 'src/components/App.tsx', kind: 'file', size: 30 },
]

test('builds a hierarchical workspace tree and prioritizes source roots', () => {
  const tree = buildWorkspaceTree(entries)
  assert.deepEqual(tree.map(node => node.path), ['src', 'docs', 'README.md'])
  assert.equal(tree[0].children[0].path, 'src/components')
  assert.equal(tree[0].children[0].children[0].path, 'src/components/App.tsx')
})

test('tree search keeps matching ancestors and does not mutate the full tree', () => {
  const tree = buildWorkspaceTree(entries)
  const before = structuredClone(tree)
  const filtered = filterWorkspaceTree(tree, 'app.tsx')
  assert.deepEqual(filtered.map(node => node.path), ['src'])
  assert.equal(filtered[0].children[0].children[0].path, 'src/components/App.tsx')
  assert.deepEqual(tree, before)
})
