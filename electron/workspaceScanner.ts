import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  WORKSPACE_MAX_DEPTH,
  WORKSPACE_MAX_ENTRIES,
  type WorkspaceEntry,
} from './workspaceProtocol.js'

const excludedDirectoryNames = new Set([
  '.git', '.hg', '.svn', '.pnpm', '.next', '.nuxt', '.cache',
  'node_modules', 'coverage', 'build', 'out', 'target',
])

const isExcludedDirectory = (name: string) => (
  excludedDirectoryNames.has(name)
  || /^dist(?:-|$)/i.test(name)
)

export interface WorkspaceScanResult {
  entries: WorkspaceEntry[]
  truncated: boolean
  warnings: string[]
}

export interface WorkspaceScanOptions {
  maxEntries?: number
  maxDepth?: number
  signal?: AbortSignal
}

const throwIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new DOMException('Workspace scan cancelled', 'AbortError')
}

export async function scanWorkspace(
  root: string,
  options: WorkspaceScanOptions = {},
): Promise<WorkspaceScanResult> {
  const maxEntries = Math.min(Math.max(options.maxEntries ?? WORKSPACE_MAX_ENTRIES, 1), WORKSPACE_MAX_ENTRIES)
  const maxDepth = Math.min(Math.max(options.maxDepth ?? WORKSPACE_MAX_DEPTH, 1), WORKSPACE_MAX_DEPTH)
  const entries: WorkspaceEntry[] = []
  const warnings = new Set<string>()
  let truncated = false

  const visit = async (directory: string, depth: number): Promise<void> => {
    throwIfAborted(options.signal)
    if (entries.length >= maxEntries) {
      truncated = true
      return
    }

    let children
    try {
      children = await fs.readdir(directory, { withFileTypes: true })
    } catch {
      warnings.add('部分目录无法访问，已跳过。')
      return
    }
    children.sort((left, right) => {
      if (left.isDirectory() !== right.isDirectory()) return left.isDirectory() ? -1 : 1
      return left.name.localeCompare(right.name)
    })

    for (const child of children) {
      throwIfAborted(options.signal)
      if (entries.length >= maxEntries) {
        truncated = true
        return
      }
      if (child.isSymbolicLink()) {
        warnings.add('符号链接未纳入工作区清单。')
        continue
      }
      if (child.isDirectory() && isExcludedDirectory(child.name)) continue

      const absolute = path.join(directory, child.name)
      const relative = path.relative(root, absolute).split(path.sep).join('/')
      if (!relative || relative.startsWith('../')) continue

      if (child.isDirectory()) {
        entries.push({ path: relative, kind: 'directory' })
        if (depth < maxDepth) await visit(absolute, depth + 1)
        else {
          truncated = true
          warnings.add(`目录扫描深度已限制为 ${maxDepth} 层。`)
        }
        continue
      }
      if (!child.isFile()) continue
      try {
        const stat = await fs.lstat(absolute)
        if (stat.isSymbolicLink() || !stat.isFile()) continue
        entries.push({ path: relative, kind: 'file', size: stat.size })
      } catch {
        warnings.add('部分文件元信息无法读取，已跳过。')
      }
    }
  }

  await visit(root, 1)
  if (truncated && entries.length >= maxEntries) warnings.add(`工作区清单最多展示 ${maxEntries} 项。`)
  return { entries, truncated, warnings: [...warnings] }
}
