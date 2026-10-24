import type { WorkspaceEntry } from '../../electron/workspaceProtocol'

export interface WorkspaceTreeNode extends WorkspaceEntry {
  name: string
  children: WorkspaceTreeNode[]
}

const preferredRoots = ['src', 'app', 'apps', 'packages', 'tests', 'test', 'docs', 'public']

const compareNodes = (left: WorkspaceTreeNode, right: WorkspaceTreeNode) => {
  const leftRank = preferredRoots.indexOf(left.name)
  const rightRank = preferredRoots.indexOf(right.name)
  if (leftRank >= 0 || rightRank >= 0) {
    if (leftRank < 0) return 1
    if (rightRank < 0) return -1
    if (leftRank !== rightRank) return leftRank - rightRank
  }
  if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1
  return left.name.localeCompare(right.name)
}

const sortTree = (nodes: WorkspaceTreeNode[]) => {
  nodes.sort(compareNodes)
  nodes.forEach(node => sortTree(node.children))
}

export function buildWorkspaceTree(entries: WorkspaceEntry[]): WorkspaceTreeNode[] {
  const byPath = new Map<string, WorkspaceTreeNode>()
  const roots: WorkspaceTreeNode[] = []
  for (const entry of entries) {
    const name = entry.path.split('/').at(-1) ?? entry.path
    byPath.set(entry.path, { ...entry, name, children: [] })
  }
  for (const node of byPath.values()) {
    const separator = node.path.lastIndexOf('/')
    const parent = separator < 0 ? undefined : byPath.get(node.path.slice(0, separator))
    if (parent?.kind === 'directory') parent.children.push(node)
    else roots.push(node)
  }
  sortTree(roots)
  return roots
}

export function filterWorkspaceTree(
  nodes: WorkspaceTreeNode[],
  query: string,
): WorkspaceTreeNode[] {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  if (!normalizedQuery) return nodes
  return nodes.flatMap((node) => {
    const children = filterWorkspaceTree(node.children, normalizedQuery)
    if (node.path.toLocaleLowerCase().includes(normalizedQuery) || children.length > 0) {
      return [{ ...node, children }]
    }
    return []
  })
}
