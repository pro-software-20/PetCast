import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { loadTs } from './load-ts.mjs'

const { scanWorkspace } = await loadTs('../electron/workspaceScanner.ts')

const withWorkspace = async (run) => {
  const root = await mkdtemp(path.join(tmpdir(), 'petcast-workspace-'))
  try {
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('workspace scan returns only relative metadata and skips excluded directories', async () => {
  await withWorkspace(async (root) => {
    await mkdir(path.join(root, 'src'), { recursive: true })
    await mkdir(path.join(root, '.git'), { recursive: true })
    await mkdir(path.join(root, 'node_modules', 'package'), { recursive: true })
    await mkdir(path.join(root, 'dist-client'), { recursive: true })
    await mkdir(path.join(root, '.android-tools', 'cache'), { recursive: true })
    await mkdir(path.join(root, '.gradle', 'cache'), { recursive: true })
    await mkdir(path.join(root, '.venv', 'lib'), { recursive: true })
    await writeFile(path.join(root, 'src', 'app.ts'), 'PRIVATE_FILE_CONTENT')
    await writeFile(path.join(root, '.git', 'config'), 'secret')
    await writeFile(path.join(root, 'node_modules', 'package', 'index.js'), 'secret')
    await writeFile(path.join(root, 'dist-client', 'bundle.js'), 'secret')
    await writeFile(path.join(root, '.android-tools', 'cache', 'tool.jar'), 'secret')
    await writeFile(path.join(root, '.gradle', 'cache', 'artifact'), 'secret')
    await writeFile(path.join(root, '.venv', 'lib', 'module.py'), 'secret')

    const result = await scanWorkspace(root)
    assert.deepEqual(result.entries, [
      { path: 'src', kind: 'directory' },
      { path: 'src/app.ts', kind: 'file', size: 20 },
    ])
    assert.equal(JSON.stringify(result).includes(root), false)
    assert.equal(JSON.stringify(result).includes('PRIVATE_FILE_CONTENT'), false)
  })
})

test('workspace scan warns when a large folder has no common project marker', async () => {
  await withWorkspace(async (root) => {
    await Promise.all(Array.from({ length: 200 }, (_, index) => (
      writeFile(path.join(root, `file-${index}.txt`), 'x')
    )))
    const result = await scanWorkspace(root)
    assert.ok(result.warnings.some(warning => warning.includes('项目根目录')))

    await writeFile(path.join(root, 'package.json'), '{}')
    const marked = await scanWorkspace(root)
    assert.equal(marked.warnings.some(warning => warning.includes('项目根目录')), false)
  })
})

test('workspace scan enforces entry and depth limits', async () => {
  await withWorkspace(async (root) => {
    await mkdir(path.join(root, 'one', 'two', 'three'), { recursive: true })
    await writeFile(path.join(root, 'a.txt'), 'a')
    await writeFile(path.join(root, 'b.txt'), 'b')

    const entryLimited = await scanWorkspace(root, { maxEntries: 2 })
    assert.equal(entryLimited.entries.length, 2)
    assert.equal(entryLimited.truncated, true)

    const depthLimited = await scanWorkspace(root, { maxDepth: 1 })
    assert.equal(depthLimited.truncated, true)
    assert.ok(depthLimited.entries.some(entry => entry.path === 'one'))
    assert.equal(depthLimited.entries.some(entry => entry.path === 'one/two'), false)
  })
})

test('workspace scan skips symbolic links where the platform permits them', async () => {
  await withWorkspace(async (root) => {
    await writeFile(path.join(root, 'target.txt'), 'target')
    try {
      await symlink(path.join(root, 'target.txt'), path.join(root, 'linked.txt'), 'file')
    } catch {
      return
    }
    const result = await scanWorkspace(root)
    assert.equal(result.entries.some(entry => entry.path === 'linked.txt'), false)
    assert.ok(result.warnings.length > 0)
  })
})

test('workspace scan responds to cancellation', async () => {
  await withWorkspace(async (root) => {
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(scanWorkspace(root, { signal: controller.signal }), error => error.name === 'AbortError')
  })
})

test('workspace scanner source never reads file contents', async () => {
  const source = await readFile(new URL('../electron/workspaceScanner.ts', import.meta.url), 'utf8')
  assert.equal(source.includes('readFile('), false)
  assert.equal(source.includes('createReadStream('), false)
})
