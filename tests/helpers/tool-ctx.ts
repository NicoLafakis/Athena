import type { ToolContext, EngineEvent } from '../../src/engine/types.js'

export function makeCtx(
  cwd: string,
  overrides: Partial<ToolContext> = {},
): ToolContext & { events: EngineEvent[] } {
  const events: EngineEvent[] = []
  return {
    cwd,
    brainDir: cwd,
    projectBrainDir: null,
    fileReadRegistry: new Set<string>(),
    todos: [],
    emit: (e) => events.push(e),
    abortSignal: new AbortController().signal,
    events,
    ...overrides,
  }
}
