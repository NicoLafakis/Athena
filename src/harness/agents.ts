import type { MessageParam } from '@anthropic-ai/sdk/resources/messages'
import { Engine } from '../engine/loop.js'
import { EngineEventBus } from '../engine/events.js'
import { ContextManager } from '../engine/context.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { HookRunner } from './hooks.js'
import type { ModelClient } from '../engine/client.js'
import type { AgentDef } from '../brain/loader.js'
import type { PermissionGate, ToolContext, ToolOutput } from '../engine/types.js'

export interface AgentOrchestratorOptions {
  defs: AgentDef[]
  clientFactory: () => ModelClient
  baseRegistry: ToolRegistry
  gate: PermissionGate // SAME instance as the parent — spec section 7
  hooks: HookRunner // SAME instance as the parent
  defaultModel: string
  systemPromptBase: string // constitution + environment; agent systemPrompt is appended
  modelWindowTokens?: number
}

export class AgentOrchestrator {
  constructor(private readonly opts: AgentOrchestratorOptions) {}

  listDefs(): AgentDef[] {
    return this.opts.defs
  }

  getDef(name: string): AgentDef | undefined {
    return this.opts.defs.find((d) => d.name === name)
  }

  /** Restricted registry: frontmatter tools (or all), minus Agent — enforces one-level nesting. */
  buildChildRegistry(def: AgentDef): ToolRegistry {
    return this.opts.baseRegistry.restrict(def.tools, ['Agent'])
  }

  async runAgent(def: AgentDef, prompt: string, parentCtx: ToolContext): Promise<ToolOutput> {
    // Parent abort must reach the child: if the parent turn is already aborted,
    // don't start the child at all.
    if (parentCtx.abortSignal.aborted) {
      return { output: `Agent ${def.name} aborted before start`, isError: true }
    }
    const bus = new EngineEventBus()
    let finalText = ''
    let fatalError: string | null = null
    let aborted = false
    bus.on((e) => {
      if (e.type === 'assistant-text') finalText += e.delta
      if (e.type === 'error' && e.fatal) fatalError = e.message
      if (e.type === 'error' && !e.fatal && e.message === 'Turn aborted') aborted = true
    })
    const engine = new Engine({
      client: this.opts.clientFactory(),
      bus,
      registry: this.buildChildRegistry(def),
      gate: this.opts.gate,
      hooks: this.opts.hooks,
      contextManager: new ContextManager({
        modelWindowTokens: this.opts.modelWindowTokens ?? 200_000,
      }),
      toolContext: { ...parentCtx, todos: [], emit: (e) => bus.emit(e) }, // child gets its own todo list
      model: def.model ?? this.opts.defaultModel,
      systemPrompt: `${this.opts.systemPromptBase}\n\n---\n\n# Agent: ${def.name}\n\n${def.systemPrompt}`,
      maxTokens: 8192,
      // askUser deliberately absent: an 'ask' decision denies inside a sub-agent; only rules/mode allow.
    })
    // engine.abort() targets the engine's CURRENT controller (runTurn replaces a
    // pre-aborted one), so the propagation can't hit a stale controller.
    const onParentAbort = () => engine.abort()
    parentCtx.abortSignal.addEventListener('abort', onParentAbort)
    try {
      await engine.runTurn(prompt)
    } finally {
      // Completed children must not leak abort listeners on the parent signal.
      parentCtx.abortSignal.removeEventListener('abort', onParentAbort)
    }
    if (fatalError !== null) {
      return { output: `Agent ${def.name} failed: ${fatalError as string}`, isError: true }
    }
    if (aborted) {
      return { output: `Agent ${def.name} aborted`, isError: true }
    }
    // Final text = text of the LAST assistant message (deltas across cycles are accumulated; reset per cycle):
    const last = [...engine.getMessages()].reverse().find((m) => m.role === 'assistant')
    const text = extractText(last) || finalText
    return { output: text.trim() || `(agent ${def.name} produced no text)`, isError: false }
  }

  /** Parallel spawn: used by the loop when one assistant message carries several Agent tool_use blocks. */
  spawnMany(
    jobs: Array<{ def: AgentDef; prompt: string }>,
    parentCtx: ToolContext,
  ): Promise<ToolOutput[]> {
    return Promise.all(jobs.map((j) => this.runAgent(j.def, j.prompt, parentCtx)))
  }
}

function extractText(m: MessageParam | undefined): string {
  if (!m) return ''
  if (typeof m.content === 'string') return m.content
  return m.content
    .filter((b): b is { type: 'text'; text: string } => (b as { type: string }).type === 'text')
    .map((b) => b.text)
    .join('')
}
