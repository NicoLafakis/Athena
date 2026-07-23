import type { MessageParam } from '@anthropic-ai/sdk/resources/messages'
import { Engine } from '../engine/loop.js'
import { EngineEventBus } from '../engine/events.js'
import { ContextManager } from '../engine/context.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { HookRunner } from './hooks.js'
import type { ModelClient } from '../engine/client.js'
import type { AgentDef } from '../brain/loader.js'
import { normalizeModel, type ProviderId, type ModelKey, type Effort } from '../brain/models.js'
import type { PermissionGate, ToolContext, ToolOutput } from '../engine/types.js'

export interface AgentOrchestratorOptions {
  defs: AgentDef[]
  clientFactory: () => ModelClient
  baseRegistry: ToolRegistry
  gate: PermissionGate // SAME instance as the parent — spec section 7
  hooks: HookRunner // SAME instance as the parent
  /** Thunk, not a snapshot: read at spawn time so /model mid-session reaches sub-agents. */
  defaultModel: () => ModelKey
  /** Thunk, same reason: /provider mid-session reaches later sub-agents. Defaults to anthropic. */
  defaultProvider?: () => ProviderId
  /** Thunk, same reason as defaultModel: /effort mid-session reaches later sub-agents. */
  defaultEffort: () => Effort
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

  /** Restricted registry: frontmatter tools (or all), minus Agent — enforces one-level nesting.
   *  A shell tool (Bash/PowerShell) implies TaskOutput: shells can start background
   *  tasks whose output is only readable via TaskOutput (read-only), so an agent
   *  must never be handed a task id it cannot poll. */
  buildChildRegistry(def: AgentDef): ToolRegistry {
    let names = def.tools
    if (
      names !== null &&
      names.some((n) => n === 'Bash' || n === 'PowerShell') &&
      !names.includes('TaskOutput')
    ) {
      names = [...names, 'TaskOutput']
    }
    return this.opts.baseRegistry.restrict(names, ['Agent'])
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
    const provider = this.opts.defaultProvider?.() ?? 'anthropic'
    const engine = new Engine({
      client: this.opts.clientFactory(),
      bus,
      registry: this.buildChildRegistry(def),
      gate: this.opts.gate,
      hooks: this.opts.hooks,
      contextManager: new ContextManager({
        modelWindowTokens: this.opts.modelWindowTokens ?? 200_000,
      }),
      // Child gets its OWN todo list and fileReadRegistry: sharing the parent's
      // registry by reference would let a child's Read unlock the parent's
      // read-before-write gate (and vice versa).
      toolContext: { ...parentCtx, todos: [], fileReadRegistry: new Set(), emit: (e) => bus.emit(e) },
      provider,
      // Frontmatter `model` is a raw string (key or legacy id); normalize it within the
      // active provider, falling back to the session default when absent or unrecognized.
      model: normalizeModel(provider, def.model ?? '') ?? this.opts.defaultModel(),
      effort: this.opts.defaultEffort(),
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
}

function extractText(m: MessageParam | undefined): string {
  if (!m) return ''
  if (typeof m.content === 'string') return m.content
  return m.content
    .filter((b): b is { type: 'text'; text: string } => (b as { type: string }).type === 'text')
    .map((b) => b.text)
    .join('')
}
