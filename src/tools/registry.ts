import type { ToolDefinition } from '../engine/types.js'

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition<never>>()

  register(tool: ToolDefinition<never>): void {
    if (this.tools.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`)
    this.tools.set(tool.name, tool)
  }

  get(name: string): ToolDefinition<never> | undefined {
    return this.tools.get(name)
  }
  list(): ToolDefinition<never>[] {
    return [...this.tools.values()]
  }

  /** Restricted copy for sub-agents (Task 12). names=null keeps all tools. */
  restrict(names: string[] | null, exclude: string[] = []): ToolRegistry {
    const next = new ToolRegistry()
    for (const t of this.list()) {
      if (exclude.includes(t.name)) continue
      if (names === null || names.includes(t.name)) next.register(t)
    }
    return next
  }
}
