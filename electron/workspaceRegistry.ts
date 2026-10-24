export class WorkspaceRegistry {
  private readonly roots = new Map<string, string>()

  set(workspaceId: string, root: string) {
    this.roots.set(workspaceId, root)
  }

  get(workspaceId: string) {
    return this.roots.get(workspaceId)
  }

  clear() {
    this.roots.clear()
  }
}
