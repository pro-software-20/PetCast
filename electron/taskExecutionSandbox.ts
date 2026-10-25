import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { TaskExecutionArtifactView, TaskExecutionFileScope } from './taskExecutionProtocol.js'

export const EXECUTION_MAX_FILES = 2_000
export const EXECUTION_MAX_TOTAL_BYTES = 50 * 1024 * 1024
export const EXECUTION_MAX_FILE_BYTES = 2 * 1024 * 1024
export const EXECUTION_MAX_DIFF_BYTES = 1024 * 1024

export class TaskSandboxError extends Error {
  constructor(readonly code: 'PATH_NOT_ALLOWED' | 'INPUT_TOO_LARGE' | 'UNSAFE_CHANGES' | 'SOURCE_CHANGED') {
    super(code)
  }
}

export interface StagedTaskWorkspace {
  root: string
  stagedRoot: string
  scope: TaskExecutionFileScope
  baseline: Map<string, { hash: string; text: string }>
  preparedFileCount: number
  preparedBytes: number
  warnings: string[]
}

export interface TaskExecutionChange {
  path: string
  beforeHash: string | null
  afterText: string
}

export interface TaskExecutionArtifact {
  id: string
  root: string
  stagedRoot: string
  changes: TaskExecutionChange[]
  diff: string
}

const normalized = (value: string) => value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '')
export const isSafeRelativePath = (value: string) => {
  const candidate = normalized(value)
  return Boolean(candidate) && candidate === value && value === value.trim()
    && !/[\u0000-\u001f:]/.test(candidate) && !candidate.startsWith('/')
    && candidate.split('/').every(part => part !== '' && part !== '.' && part !== '..')
}
const inside = (candidate: string, parent: string) => candidate === parent || candidate.startsWith(`${parent}/`)
const inAny = (candidate: string, ranges: string[]) => ranges.some(range => inside(candidate, normalized(range)))
const forbidden = (candidate: string, scope: TaskExecutionFileScope) => inAny(candidate, scope.forbiddenPaths)
const writable = (candidate: string, scope: TaskExecutionFileScope) => (
  !forbidden(candidate, scope)
  && (inAny(candidate, scope.allowedWritePaths) || inAny(candidate, scope.outputPaths))
)
const hash = (buffer: Uint8Array) => createHash('sha256').update(buffer).digest('hex')
const decodeText = (buffer: Uint8Array) => {
  if (buffer.includes(0)) throw new TaskSandboxError('UNSAFE_CHANGES')
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer) }
  catch { throw new TaskSandboxError('UNSAFE_CHANGES') }
}

const safeAbsolute = (root: string, relative: string) => {
  if (!isSafeRelativePath(relative)) throw new TaskSandboxError('PATH_NOT_ALLOWED')
  const absolute = path.resolve(root, ...normalized(relative).split('/'))
  const relativeBack = path.relative(root, absolute)
  if (!relativeBack || relativeBack.startsWith('..') || path.isAbsolute(relativeBack)) {
    throw new TaskSandboxError('PATH_NOT_ALLOWED')
  }
  return absolute
}

async function collectFiles(root: string, relative: string, output: Set<string>, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new TaskSandboxError('UNSAFE_CHANGES')
  const absolute = safeAbsolute(root, relative)
  let stat
  try { stat = await fs.lstat(absolute) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (stat.isSymbolicLink()) throw new TaskSandboxError('UNSAFE_CHANGES')
  if (stat.isFile()) {
    output.add(normalized(relative))
    if (output.size > EXECUTION_MAX_FILES) throw new TaskSandboxError('INPUT_TOO_LARGE')
    return
  }
  if (!stat.isDirectory()) throw new TaskSandboxError('UNSAFE_CHANGES')
  for (const entry of await fs.readdir(absolute, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new TaskSandboxError('UNSAFE_CHANGES')
    await collectFiles(root, `${normalized(relative)}/${entry.name}`, output, signal)
  }
}

export async function stageTaskWorkspace(options: {
  root: string
  stagedRoot: string
  scope: TaskExecutionFileScope
  signal?: AbortSignal
}): Promise<StagedTaskWorkspace> {
  const scope = structuredClone(options.scope)
  const requested = [...scope.readPaths, ...scope.allowedWritePaths, ...scope.outputPaths]
  if (!requested.length || requested.some(value => !isSafeRelativePath(value))
    || scope.forbiddenPaths.some(value => !isSafeRelativePath(value))) {
    throw new TaskSandboxError('PATH_NOT_ALLOWED')
  }
  const files = new Set<string>()
  for (const relative of requested) {
    if (!forbidden(normalized(relative), scope)) await collectFiles(options.root, relative, files, options.signal)
  }
  const authorizedFiles = [...files].filter(relative => !forbidden(relative, scope))
  if (authorizedFiles.length > EXECUTION_MAX_FILES) throw new TaskSandboxError('INPUT_TOO_LARGE')
  await fs.mkdir(options.stagedRoot, { recursive: true })
  const baseline = new Map<string, { hash: string; text: string }>()
  let total = 0
  for (const relative of authorizedFiles.sort()) {
    if (options.signal?.aborted) throw new TaskSandboxError('UNSAFE_CHANGES')
    const source = safeAbsolute(options.root, relative)
    const stat = await fs.lstat(source)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new TaskSandboxError('UNSAFE_CHANGES')
    if (stat.size > EXECUTION_MAX_FILE_BYTES) throw new TaskSandboxError('INPUT_TOO_LARGE')
    total += stat.size
    if (total > EXECUTION_MAX_TOTAL_BYTES) throw new TaskSandboxError('INPUT_TOO_LARGE')
    const buffer = await fs.readFile(source)
    const text = decodeText(buffer)
    const target = safeAbsolute(options.stagedRoot, relative)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, buffer, { flag: 'wx' })
    baseline.set(relative, { hash: hash(buffer), text })
  }
  return {
    root: options.root,
    stagedRoot: options.stagedRoot,
    scope,
    baseline,
    preparedFileCount: baseline.size,
    preparedBytes: total,
    warnings: [],
  }
}

async function scanStagedFiles(root: string) {
  const files = new Set<string>()
  const visit = async (directory: string, prefix = ''): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new TaskSandboxError('UNSAFE_CHANGES')
      const relative = normalized(prefix ? `${prefix}/${entry.name}` : entry.name)
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), relative)
      else if (entry.isFile()) files.add(relative)
      else throw new TaskSandboxError('UNSAFE_CHANGES')
      if (files.size > EXECUTION_MAX_FILES) throw new TaskSandboxError('INPUT_TOO_LARGE')
    }
  }
  await visit(root)
  return files
}

const diffFor = (relative: string, before: string, after: string) => {
  const oldLines = before.split(/\r?\n/)
  const newLines = after.split(/\r?\n/)
  const body = [
    `--- a/${relative}`,
    `+++ b/${relative}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines.map(line => `-${line}`),
    ...newLines.map(line => `+${line}`),
  ].join('\n')
  return body
}

export async function createTaskExecutionArtifact(staged: StagedTaskWorkspace): Promise<TaskExecutionArtifact> {
  const afterFiles = await scanStagedFiles(staged.stagedRoot)
  for (const relative of staged.baseline.keys()) {
    if (!afterFiles.has(relative)) throw new TaskSandboxError('UNSAFE_CHANGES')
  }
  const changes: TaskExecutionChange[] = []
  const diffs: string[] = []
  let total = 0
  for (const relative of [...afterFiles].sort()) {
    const buffer = await fs.readFile(safeAbsolute(staged.stagedRoot, relative))
    total += buffer.length
    if (buffer.length > EXECUTION_MAX_FILE_BYTES || total > EXECUTION_MAX_TOTAL_BYTES) {
      throw new TaskSandboxError('INPUT_TOO_LARGE')
    }
    const afterText = decodeText(buffer)
    const before = staged.baseline.get(relative)
    const afterHash = hash(buffer)
    if (before?.hash === afterHash) continue
    if (!writable(relative, staged.scope)) throw new TaskSandboxError('UNSAFE_CHANGES')
    changes.push({ path: relative, beforeHash: before?.hash ?? null, afterText })
    diffs.push(diffFor(relative, before?.text ?? '', afterText))
  }
  const diff = diffs.join('\n')
  if (Buffer.byteLength(diff) > EXECUTION_MAX_DIFF_BYTES) throw new TaskSandboxError('INPUT_TOO_LARGE')
  return { id: randomUUID(), root: staged.root, stagedRoot: staged.stagedRoot, changes, diff }
}

export const viewTaskExecutionArtifact = (artifact: TaskExecutionArtifact): TaskExecutionArtifactView => ({
  artifactId: artifact.id,
  changedFiles: artifact.changes.map(change => change.path),
  diff: artifact.diff,
  safetyStatus: 'safe',
})

const currentHash = async (file: string) => {
  try {
    const stat = await fs.lstat(file)
    if (stat.isSymbolicLink() || !stat.isFile()) throw new TaskSandboxError('SOURCE_CHANGED')
    return hash(await fs.readFile(file))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function assertNoSymlinkParent(root: string, relative: string) {
  const parts = normalized(relative).split('/').slice(0, -1)
  let current = root
  for (const part of parts) {
    current = path.join(current, part)
    try {
      const stat = await fs.lstat(current)
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new TaskSandboxError('SOURCE_CHANGED')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
  }
}

export async function applyTaskExecutionArtifact(artifact: TaskExecutionArtifact) {
  for (const change of artifact.changes) {
    const target = safeAbsolute(artifact.root, change.path)
    await assertNoSymlinkParent(artifact.root, change.path)
    if (await currentHash(target) !== change.beforeHash) throw new TaskSandboxError('SOURCE_CHANGED')
  }
  const completed: Array<{ target: string; backup?: string }> = []
  try {
    for (const change of artifact.changes) {
      const target = safeAbsolute(artifact.root, change.path)
      await fs.mkdir(path.dirname(target), { recursive: true })
      const temp = `${target}.petcast-${randomUUID()}.tmp`
      const backup = change.beforeHash === null ? undefined : `${target}.petcast-${randomUUID()}.bak`
      await fs.writeFile(temp, change.afterText, { flag: 'wx', encoding: 'utf8' })
      if (backup) await fs.rename(target, backup)
      try { await fs.rename(temp, target) }
      catch (error) {
        if (backup) await fs.rename(backup, target).catch(() => undefined)
        await fs.unlink(temp).catch(() => undefined)
        throw error
      }
      completed.push({ target, backup })
    }
    await Promise.all(completed.map(item => item.backup ? fs.unlink(item.backup).catch(() => undefined) : undefined))
  } catch (error) {
    for (const item of completed.reverse()) {
      await fs.unlink(item.target).catch(() => undefined)
      if (item.backup) await fs.rename(item.backup, item.target).catch(() => undefined)
    }
    throw error
  }
}

export async function discardTaskExecutionArtifact(artifact: TaskExecutionArtifact) {
  await fs.rm(artifact.stagedRoot, { recursive: true, force: true })
}
