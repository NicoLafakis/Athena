import type {
  MessageParam,
  Tool,
  ToolResultBlockParam,
  ToolUseBlock,
} from '@anthropic-ai/sdk/resources/messages'
import type { z } from 'zod'
import type { ModelClient } from './client.js'
import type { EngineEventBus } from './events.js'
import type { ContextManager } from './context.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { HookRunner } from '../harness/hooks.js'
import type { PermissionGate, ToolContext, ToolOutput, TokenUsage } from './types.js'

export type AskUserFn = (req: {
  toolName: string
  input: unknown
  summary: string
  reason: string
}) => Promise<'allow-once' | 'allow-always' | 'deny'>

export interface EngineOptions {
  client: ModelClient
  bus: EngineEventBus
  registry: ToolRegistry
  gate: PermissionGate
  hooks: HookRunner
  contextManager: ContextManager
  toolContext: ToolContext
  model: string
  systemPrompt: string
  maxTokens: number
  askUser?: AskUserFn // TUI wires this; headless default denies
  abortController?: AbortController
  onMessagesChanged?: (messages: MessageParam[]) => void // session persistence seam (Task 11)
}

export class Engine {
  private messages: MessageParam[] = []
  private readonly opts: EngineOptions
  private abortController: AbortController

  constructor(opts: EngineOptions) {
    this.opts = opts
    this.abortController = opts.abortController ?? new AbortController()
  }

  getMessages(): MessageParam[] {
    return this.messages
  }

  loadMessages(history: MessageParam[]): void {
    this.messages = [...history]
  }

  abort(): void {
    this.abortController.abort()
  }

  setModel(model: string): void {
    this.opts.model = model
  }

  private toApiTools(): Tool[] {
    return this.opts.registry.list().map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: zodToJsonSchema(t.schema),
    }))
  }

  /** One turn: user text in -> model/tool cycles -> turn-done. Never throws for tool errors. */
  async runTurn(userText: string): Promise<void> {
    const { bus, client, hooks, contextManager } = this.opts
    if (this.abortController.signal.aborted) this.abortController = new AbortController()
    const signal = this.abortController.signal
    const promptHook = await hooks.run('UserPromptSubmit', { prompt: userText })
    const text = promptHook.addedContext
      ? `${userText}\n\n<hook-context>\n${promptHook.addedContext}\n</hook-context>`
      : userText
    this.push({ role: 'user', content: text })
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }

    for (;;) {
      if (signal.aborted) {
        bus.emit({ type: 'error', message: 'Turn aborted', fatal: false })
        break
      }
      let result
      try {
        result = await client.stream(
          {
            model: this.opts.model,
            system: this.opts.systemPrompt,
            messages: this.messages,
            tools: this.toApiTools(),
            maxTokens: this.opts.maxTokens,
            signal,
          },
          {
            onTextDelta: (d) => bus.emit({ type: 'assistant-text', delta: d }),
            onThinkingDelta: (d) => bus.emit({ type: 'assistant-thinking', delta: d }),
          },
        )
      } catch (err) {
        const aborted = signal.aborted
        bus.emit({
          type: 'error',
          message: aborted ? 'Turn aborted' : `API error: ${(err as Error).message}`,
          fatal: !aborted,
        })
        break
      }
      const msg = result.message
      usage = {
        inputTokens: msg.usage.input_tokens,
        outputTokens: msg.usage.output_tokens,
        cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
      }
      contextManager.update(usage)
      this.push({ role: 'assistant', content: msg.content })

      const toolUses = msg.content.filter((b): b is ToolUseBlock => b.type === 'tool_use')
      if (msg.stop_reason !== 'tool_use' || toolUses.length === 0) break

      // Parallel tool_use blocks are executed sequentially in block order (Task 12 adds the Agent-batch exception).
      const results: ToolResultBlockParam[] = []
      let abortedMidTools = false
      for (const block of toolUses) {
        if (signal.aborted) {
          // Synthesize an aborted result: every tool_use block must have a tool_result,
          // or the transcript is invalid on the next API call.
          abortedMidTools = true
          const out: ToolOutput = { output: 'Tool execution aborted', isError: true }
          bus.emit({
            type: 'tool-result',
            id: block.id,
            name: block.name,
            output: out.output,
            isError: out.isError,
          })
          results.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: out.output,
            is_error: out.isError,
          })
          continue
        }
        bus.emit({ type: 'tool-request', id: block.id, name: block.name, input: block.input })
        const out = await this.dispatchTool(block, signal)
        bus.emit({
          type: 'tool-result',
          id: block.id,
          name: block.name,
          output: out.output,
          isError: out.isError,
        })
        results.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: out.output,
          is_error: out.isError,
        })
      }
      if (results.length > 0) this.push({ role: 'user', content: results })
      if (abortedMidTools) {
        bus.emit({ type: 'error', message: 'Turn aborted', fatal: false })
        break
      }

      if (contextManager.needsCompaction()) {
        try {
          const { messages: compacted, summary } = await contextManager.compact(this.messages, (p) =>
            client.complete({ model: this.opts.model, prompt: p, maxTokens: 2048 }),
          )
          // summary === '' means compaction was skipped (too few messages / no clean
          // boundary) — nothing changed, so no event.
          if (summary !== '') {
            this.messages = compacted
            this.opts.onMessagesChanged?.(this.messages)
            bus.emit({ type: 'compaction', summary })
          }
        } catch (err) {
          // A failed summarization call (rate limit, network) must not kill the turn:
          // continue uncompacted and let a later cycle retry.
          bus.emit({
            type: 'error',
            message: `Compaction failed: ${(err as Error).message}`,
            fatal: false,
          })
        }
      }
    }
    await hooks.run('Stop', {})
    bus.emit({ type: 'turn-done', usage })
  }

  /** Permission gate -> PreToolUse hooks -> validate -> execute -> PostToolUse. Every failure becomes an error tool result. */
  private async dispatchTool(block: ToolUseBlock, signal: AbortSignal): Promise<ToolOutput> {
    const { gate, hooks, registry, toolContext } = this.opts
    const tool = registry.get(block.name)
    if (!tool) return { output: `Unknown tool: ${block.name}`, isError: true }

    const decision = gate.check({
      toolName: block.name,
      input: block.input,
      readOnly: tool.readOnly,
      summary: summarize(block),
    })
    let allowed = decision.decision === 'allow'
    let denyReason = decision.reason
    if (decision.decision === 'ask') {
      const answer = this.opts.askUser
        ? await this.opts.askUser({
            toolName: block.name,
            input: block.input,
            summary: summarize(block),
            reason: decision.reason,
          })
        : ('deny' as const)
      if (answer === 'allow-always') {
        gate.grantSession(ruleFor(block))
        allowed = true
      } else {
        allowed = answer === 'allow-once'
      }
      if (!allowed) {
        denyReason = this.opts.askUser
          ? 'denied by user'
          : 'denied (headless: no approver wired for permission prompts)'
      }
    }
    if (!allowed) return { output: `Permission denied: ${denyReason}`, isError: true }

    const pre = await hooks.run('PreToolUse', { toolName: block.name, input: block.input })
    if (!pre.allowed) {
      return {
        output: `Blocked by PreToolUse hook: ${pre.reason ?? 'no reason given'}`,
        isError: true,
      }
    }

    const parsed = tool.schema.safeParse(block.input)
    if (!parsed.success) {
      return { output: `Invalid input for ${block.name}: ${parsed.error.message}`, isError: true }
    }

    let out: ToolOutput
    try {
      out = await tool.execute(parsed.data as never, { ...toolContext, abortSignal: signal })
    } catch (err) {
      out = { output: `${block.name} threw: ${(err as Error).message}`, isError: true }
    }
    await hooks.run('PostToolUse', { toolName: block.name, input: block.input, output: out.output })
    return out
  }

  private push(m: MessageParam): void {
    this.messages.push(m)
    this.opts.onMessagesChanged?.(this.messages)
  }
}

function summarize(block: ToolUseBlock): string {
  const input = JSON.stringify(block.input)
  return `${block.name}(${input.length > 120 ? input.slice(0, 120) + '…' : input})`
}

/** "Always allow" rule derived from the request: Bash gets a command-prefix rule, file tools get their path. */
function ruleFor(block: ToolUseBlock): string {
  const obj = (block.input ?? {}) as Record<string, unknown>
  if (block.name === 'Bash' || block.name === 'PowerShell') {
    const first = String(obj['command'] ?? '').trim().split(/\s+/)[0] ?? ''
    return `${block.name}(${first}:*)`
  }
  if (typeof obj['file_path'] === 'string') {
    return `${block.name}(${String(obj['file_path']).replaceAll('\\', '/')})`
  }
  return block.name
}

interface JsonSchemaNode {
  type?: string
  properties?: Record<string, JsonSchemaNode>
  required?: string[]
  items?: JsonSchemaNode
  enum?: string[]
  [k: string]: unknown
}

interface ZodDefLike {
  typeName?: string
  innerType?: z.ZodTypeAny
  type?: z.ZodTypeAny
  values?: string[]
  shape?: () => Record<string, z.ZodTypeAny>
}

function convert(schema: z.ZodTypeAny): { node: JsonSchemaNode; optional: boolean } {
  const def = (schema as { _def: ZodDefLike })._def
  switch (def.typeName) {
    case 'ZodOptional':
    case 'ZodDefault': {
      const inner = convert(def.innerType!)
      return { node: inner.node, optional: true }
    }
    case 'ZodString':
      return { node: { type: 'string' }, optional: false }
    case 'ZodNumber':
      return { node: { type: 'number' }, optional: false }
    case 'ZodBoolean':
      return { node: { type: 'boolean' }, optional: false }
    case 'ZodEnum':
      return { node: { type: 'string', enum: [...(def.values ?? [])] }, optional: false }
    case 'ZodArray':
      return { node: { type: 'array', items: convert(def.type!).node }, optional: false }
    case 'ZodObject': {
      const shape = def.shape!()
      const properties: Record<string, JsonSchemaNode> = {}
      const required: string[] = []
      for (const [key, value] of Object.entries(shape)) {
        const { node, optional } = convert(value)
        properties[key] = node
        if (!optional) required.push(key)
      }
      const node: JsonSchemaNode = { type: 'object', properties }
      if (required.length > 0) node.required = required
      return { node, optional: false }
    }
    default:
      return { node: {}, optional: false }
  }
}

/** Minimal zod -> JSON Schema conversion for object schemas (string/number/boolean/enum/array/optional/default). */
export function zodToJsonSchema(schema: z.ZodType<unknown>): Tool['input_schema'] {
  const { node } = convert(schema as z.ZodTypeAny)
  // Tool inputs must be objects at the top level; anything else degrades to an open object.
  return (node.type === 'object' ? node : { type: 'object', properties: {} }) as Tool['input_schema']
}
