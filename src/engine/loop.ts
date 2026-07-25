import { resolve } from 'node:path'
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
import { estimateRequestTokens } from './context.js'
import { RunBudget } from './run.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { HookRunner } from '../harness/hooks.js'
import {
  modelCapabilities,
  modelId,
  normalizeModel,
  resolveModelRequest,
  supportsThinking,
  usageCostUsd,
  PROVIDERS,
  type ProviderId,
  type ModelKey,
  type Effort,
} from '../brain/models.js'
import type {
  PermissionGate,
  RunLimits,
  RunResult,
  ToolContext,
  ToolDefinition,
  ToolOutput,
  TokenUsage,
} from './types.js'

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
  /** Active provider; defaults to 'anthropic' so pre-provider constructions keep working. */
  provider?: ProviderId
  model: ModelKey
  effort: Effort
  systemPrompt: string
  maxTokens: number
  askUser?: AskUserFn // TUI wires this; headless default denies
  abortController?: AbortController
  onMessagesChanged?: (messages: MessageParam[]) => void // session persistence seam (Task 11)
  limits?: RunLimits
  preflightContext?: boolean
}

export class Engine {
  private messages: MessageParam[] = []
  private readonly opts: EngineOptions
  private abortController: AbortController
  private turnInFlight = false
  private readonly budget: RunBudget

  constructor(opts: EngineOptions) {
    this.opts = opts
    this.abortController = opts.abortController ?? new AbortController()
    this.budget = new RunBudget(opts.limits)
  }

  getMessages(): MessageParam[] {
    return this.messages
  }

  getRunResult(): RunResult {
    return this.budget.getResult()
  }

  loadMessages(history: MessageParam[]): void {
    // A crash mid-tool persists an assistant tool_use with no tool_result; an
    // unrepaired resume would 400 on every subsequent API call, forever.
    this.messages = repairDanglingToolUses(history)
  }

  abort(): void {
    this.abortController.abort()
  }

  setModel(key: ModelKey): void {
    this.opts.model = key
  }

  getModel(): ModelKey {
    return this.opts.model
  }

  setProvider(p: ProviderId): void {
    this.opts.provider = p
    // Self-heal: a model key from another provider would make resolveModelRequest throw
    // outside the stream try/catch (process-killing unhandled rejection). Reset to the
    // new provider's default; callers that want a specific model call setModel after.
    if (!normalizeModel(p, this.opts.model)) this.opts.model = PROVIDERS[p].defaultModel
  }

  getProvider(): ProviderId {
    return this.opts.provider ?? 'anthropic'
  }

  setEffort(e: Effort): void {
    this.opts.effort = e
  }

  getEffort(): Effort {
    return this.opts.effort
  }

  /** Resolved wire id for the current provider+key — what the API and the compactor need. */
  getModelId(): string {
    return modelId(this.getProvider(), this.opts.model)
  }

  private toApiTools(): Tool[] {
    return this.opts.registry.list().map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: toolInputSchema(t),
    }))
  }

  /** One turn: user text in -> model/tool cycles -> turn-done. Never throws for tool errors. */
  async runTurn(userText: string): Promise<RunResult> {
    // Reentrancy guard: a second prompt mid-turn would interleave a user message
    // between a tool_use and its tool_result — API 400 + corrupt persisted session.
    if (this.turnInFlight) {
      this.opts.bus.emit({
        type: 'error',
        message:
          'A turn is already in progress — wait for it to finish (or Esc to abort) before sending another prompt.',
        fatal: false,
      })
      return this.budget.failed('turn already in progress')
    }
    const turnLimit = this.budget.beginTurn()
    if (turnLimit) return this.emitLimit(turnLimit)
    this.opts.bus.emit({ type: 'turn-start', turn: this.budget.snapshot().turns })
    this.turnInFlight = true
    const remaining = this.budget.remainingDurationMs()
    let deadlineTimer: NodeJS.Timeout | null = null
    if (Number.isFinite(remaining)) {
      deadlineTimer = setTimeout(() => {
        this.budget.limited('maxDurationMs')
        this.abort()
      }, remaining)
    }
    try {
      return await this.runTurnInner(userText)
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer)
      this.turnInFlight = false
    }
  }

  private async runTurnInner(userText: string): Promise<RunResult> {
    const { bus, client, hooks, contextManager } = this.opts
    if (this.abortController.signal.aborted) this.abortController = new AbortController()
    const signal = this.abortController.signal
    const promptHook = await hooks.run('UserPromptSubmit', { prompt: userText })
    if (!promptHook.allowed) {
      // Claude Code semantics: a denying UserPromptSubmit hook blocks the prompt
      // entirely — nothing is added to history and the API is never called.
      bus.emit({
        type: 'error',
        message: `Prompt blocked by UserPromptSubmit hook: ${promptHook.reason ?? 'no reason given'}`,
        fatal: false,
      })
      bus.emit({
        type: 'turn-done',
        usage: this.budget.snapshot(),
      })
      return this.budget.completed()
    }
    const text = promptHook.addedContext
      ? `${userText}\n\n<hook-context>\n${promptHook.addedContext}\n</hook-context>`
      : userText
    this.push({ role: 'user', content: text })
    let terminal: RunResult | null = null

    for (;;) {
      if (signal.aborted) {
        const current = this.budget.getResult()
        terminal =
          current.status === 'limit'
            ? current
            : this.budget.aborted('aborted')
        bus.emit({
          type: 'error',
          message: terminal.status === 'limit' ? `Run limit reached: ${terminal.reason}` : 'Turn aborted',
          fatal: false,
        })
        break
      }
      // Resolve provider+key -> wire id + per-model effort/thinking. Anthropic Haiku and
      // all Kimi models return neither (both 400 there); gating lives in resolveModelRequest.
      const req = resolveModelRequest(this.getProvider(), this.opts.model, this.opts.effort)
      const capabilities = modelCapabilities(this.getProvider(), this.opts.model)
      const tools = this.toApiTools()
      const requestMaxTokens = Math.min(this.opts.maxTokens, capabilities.maxOutputTokens)
      let outboundMessages = this.outboundMessages()
      let estimatedInputTokens = 0
      if (this.opts.preflightContext) {
        contextManager.setModelWindowTokens(capabilities.contextWindowTokens)
        estimatedInputTokens = estimateRequestTokens({
          system: this.opts.systemPrompt,
          messages: outboundMessages,
          tools,
        })
      }
      if (
        this.opts.preflightContext &&
        !contextManager.fitsEstimated(estimatedInputTokens, requestMaxTokens)
      ) {
        let preflightCompactionLimit: string | null = null
        try {
          const { messages: compacted, summary } = await contextManager.compact(
            this.messages,
            async (prompt) => {
              const before = this.budget.beforeModelCall(estimateRequestTokens(prompt))
              if (before) {
                preflightCompactionLimit = before
                throw new Error(`preflight compaction blocked by ${before}`)
              }
              if (client.completeDetailed) {
                const completion = await client.completeDetailed({
                  model: this.getModelId(),
                  prompt,
                  maxTokens: 2048,
                  signal,
                })
                if (completion.usage) {
                  preflightCompactionLimit =
                    this.budget.addUsage(
                      completion.usage,
                      usageCostUsd(this.getProvider(), this.opts.model, completion.usage),
                    ) ?? preflightCompactionLimit
                }
                return completion.text
              }
              return client.complete({
                model: this.getModelId(),
                prompt,
                maxTokens: 2048,
                signal,
              })
            },
          )
          if (summary !== '') {
            this.messages = compacted
            this.opts.onMessagesChanged?.(this.messages)
            bus.emit({ type: 'compaction', summary })
            outboundMessages = this.outboundMessages()
            estimatedInputTokens = estimateRequestTokens({
              system: this.opts.systemPrompt,
              messages: outboundMessages,
              tools,
            })
          }
          if (preflightCompactionLimit) {
            terminal = this.recordLimit(preflightCompactionLimit)
            break
          }
        } catch (err) {
          if (preflightCompactionLimit) {
            terminal = this.recordLimit(preflightCompactionLimit)
            break
          }
          bus.emit({
            type: 'error',
            message: `Preflight compaction failed: ${(err as Error).message}`,
            fatal: false,
          })
        }
      }
      if (
        this.opts.preflightContext &&
        !contextManager.fitsEstimated(estimatedInputTokens, requestMaxTokens)
      ) {
        terminal = this.recordLimit('contextWindow')
        break
      }
      const modelLimit = this.budget.beforeModelCall(estimatedInputTokens)
      if (modelLimit) {
        terminal = this.recordLimit(modelLimit)
        break
      }
      let result
      try {
        result = await client.stream(
          {
            model: req.model,
            thinking: req.thinking,
            effort: req.effort,
            system: this.opts.systemPrompt,
            // Anthropic thinking blocks carry provider-signed signatures; replaying them to a
            // model that does not speak thinking (any Kimi model) risks a 400 on the compat
            // endpoint. Strip them from the outbound view only - history stays intact so a
            // switch back to a thinking model keeps its blocks. A message whose content
            // array is emptied by the filter is dropped entirely (an empty array 400s too).
            messages: outboundMessages,
            tools,
            maxTokens: requestMaxTokens,
            signal,
          },
          {
            onTextDelta: (d) => bus.emit({ type: 'assistant-text', delta: d }),
            onThinkingDelta: (d) => bus.emit({ type: 'assistant-thinking', delta: d }),
          },
        )
      } catch (err) {
        const aborted = signal.aborted
        const status = (err as { status?: number }).status
        // 401/403 = the key itself was rejected: point at `athena auth`, never a raw SDK stack.
        const message = aborted
          ? 'Turn aborted'
          : status === 401 || status === 403
            ? `API key rejected for ${this.getProvider()} - run \`athena auth\``
            : `API error: ${(err as Error).message}`
        bus.emit({ type: 'error', message, fatal: !aborted })
        terminal = aborted
          ? (this.budget.getResult().status === 'limit'
              ? this.budget.getResult()
              : this.budget.aborted('aborted'))
          : this.budget.failed(message)
        break
      }
      const msg = result.message
      const responseUsage: TokenUsage = {
        inputTokens: msg.usage.input_tokens,
        outputTokens: msg.usage.output_tokens,
        cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: msg.usage.cache_creation_input_tokens ?? 0,
      }
      const usageLimit = this.budget.addUsage(
        responseUsage,
        usageCostUsd(this.getProvider(), this.opts.model, responseUsage),
      )
      contextManager.update(responseUsage)
      this.push({ role: 'assistant', content: msg.content })

      const toolUses = msg.content.filter((b): b is ToolUseBlock => b.type === 'tool_use')
      if (msg.stop_reason !== 'tool_use' || toolUses.length === 0) {
        if (usageLimit) terminal = this.recordLimit(usageLimit)
        break
      }

      // Parallel tool_use blocks are executed sequentially in block order, EXCEPT a
      // batch that is entirely Agent calls: sub-agents are independent loops, so they
      // dispatch concurrently (spec section 7). Mixed batches stay sequential.
      const results: ToolResultBlockParam[] = []
      let abortedMidTools = false
      const toolLimit = usageLimit ?? this.budget.beforeToolCalls(toolUses.length)
      if (toolLimit) {
        terminal = this.recordLimit(toolLimit)
        for (const block of toolUses) {
          const output = `Tool not executed: run limit reached (${toolLimit})`
          bus.emit({ type: 'tool-result', id: block.id, name: block.name, output, isError: true })
          results.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: output,
            is_error: true,
          })
        }
        this.push({ role: 'user', content: results })
        break
      }
      const agentTool = this.opts.registry.get('Agent')
      const allAgentCalls =
        !signal.aborted &&
        toolUses.length > 1 &&
        toolUses.every(
          (block) =>
            block.name === 'Agent' &&
            (agentTool?.concurrencySafe
              ? agentTool.concurrencySafe(block.input as never)
              : agentTool?.readOnly === true),
        )
      if (allAgentCalls) {
        for (const block of toolUses) {
          bus.emit({ type: 'tool-request', id: block.id, name: block.name, input: block.input })
        }
        const outs = await mapWithConcurrency(
          toolUses,
          Math.max(1, this.opts.limits?.maxConcurrency ?? 4),
          (block) => this.dispatchTool(block, signal),
        )
        toolUses.forEach((block, i) => {
          const out = outs[i]!
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
            content: out.content ?? out.output,
            is_error: out.isError,
          })
        })
      } else {
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
              content: out.content ?? out.output,
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
            content: out.content ?? out.output,
            is_error: out.isError,
          })
        }
      }
      if (results.length > 0) this.push({ role: 'user', content: results })
      if (abortedMidTools) {
        terminal = this.budget.aborted('aborted')
        bus.emit({ type: 'error', message: 'Turn aborted', fatal: false })
        break
      }

      if (contextManager.needsCompaction()) {
        let compactionLimit: string | null = null
        try {
          const preCompact = await hooks.run('PreCompact', {
            messageCount: this.messages.length,
            contextFraction: contextManager.usedFraction(),
          })
          if (!preCompact.allowed) {
            bus.emit({
              type: 'error',
              message: `Compaction blocked by hook: ${preCompact.reason ?? 'no reason given'}`,
              fatal: false,
            })
            break
          }
          const { messages: compacted, summary } = await contextManager.compact(
            this.messages,
            async (prompt) => {
              const before = this.budget.beforeModelCall(estimateRequestTokens(prompt))
              if (before) {
                compactionLimit = before
                throw new Error(`compaction blocked by ${before}`)
              }
              if (client.completeDetailed) {
                const completion = await client.completeDetailed({
                  model: this.getModelId(),
                  prompt,
                  maxTokens: 2048,
                  signal,
                })
                if (completion.usage) {
                  compactionLimit =
                    this.budget.addUsage(
                      completion.usage,
                      usageCostUsd(this.getProvider(), this.opts.model, completion.usage),
                    ) ?? compactionLimit
                }
                return completion.text
              }
              return client.complete({
                model: this.getModelId(),
                prompt,
                maxTokens: 2048,
                signal,
              })
            },
          )
          // summary === '' means compaction was skipped (too few messages / no clean
          // boundary) — nothing changed, so no event.
          if (summary !== '') {
            this.messages = compacted
            this.opts.onMessagesChanged?.(this.messages)
            bus.emit({ type: 'compaction', summary })
            const postCompact = await hooks.run('PostCompact', {
              summary,
              messageCount: this.messages.length,
            })
            if (postCompact.systemMessage) {
              bus.emit({ type: 'info', message: postCompact.systemMessage })
            }
          }
          if (compactionLimit) {
            terminal = this.recordLimit(compactionLimit)
            break
          }
        } catch (err) {
          if (compactionLimit) {
            terminal = this.recordLimit(compactionLimit)
            break
          }
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
    // Push the fresh context fill to the status line before signalling turn-done; turn-done
    // stays the last event of the turn (tests and the TUI both key off that).
    bus.emit({ type: 'status', patch: { contextPct: Math.round(contextManager.usedFraction() * 100) } })
    const result = terminal ?? this.budget.completed()
    bus.emit({ type: 'turn-done', usage: result.usage })
    return result
  }

  private outboundMessages(): MessageParam[] {
    if (supportsThinking(this.getProvider(), this.opts.model)) return this.messages
    return this.messages
      .map((message) =>
        Array.isArray(message.content)
          ? {
              ...message,
              content: message.content.filter(
                (block) => block.type !== 'thinking' && block.type !== 'redacted_thinking',
              ),
            }
          : message,
      )
      .filter((message) => !Array.isArray(message.content) || message.content.length > 0)
  }

  private recordLimit(reason: string): RunResult {
    const result = this.budget.limited(reason)
    this.opts.bus.emit({ type: 'run-limit', limit: reason, usage: result.usage })
    this.opts.bus.emit({
      type: 'error',
      message: `Run limit reached: ${reason}`,
      fatal: false,
    })
    return result
  }

  private emitLimit(reason: string): RunResult {
    const result = this.recordLimit(reason)
    this.opts.bus.emit({ type: 'turn-done', usage: result.usage })
    return result
  }

  /** Permission gate -> PreToolUse hooks -> validate -> execute -> PostToolUse. Every failure becomes an error tool result. */
  private async dispatchTool(block: ToolUseBlock, signal: AbortSignal): Promise<ToolOutput> {
    const { gate, hooks, registry, toolContext } = this.opts
    const tool = registry.get(block.name)
    if (!tool) return { output: `Unknown tool: ${block.name}`, isError: true }

    const pre = await hooks.run('PreToolUse', { toolName: block.name, input: block.input })
    if (!pre.allowed) {
      return {
        output: `Blocked by PreToolUse hook: ${pre.reason ?? 'no reason given'}`,
        isError: true,
      }
    }
    const effectiveInput = pre.updatedInput ?? block.input
    const parsed = tool.schema.safeParse(effectiveInput)
    if (!parsed.success) {
      return { output: `Invalid input for ${block.name}: ${parsed.error.message}`, isError: true }
    }
    const effectiveBlock = { ...block, input: parsed.data } as ToolUseBlock
    const permissionHook = await hooks.run('PermissionRequest', {
      toolName: block.name,
      input: parsed.data,
      readOnly: tool.readOnly,
    })
    if (!permissionHook.allowed) {
      return {
        output: `Permission denied by hook: ${permissionHook.reason ?? 'no reason given'}`,
        isError: true,
      }
    }
    const decision = gate.check({
      toolName: block.name,
      input: parsed.data,
      readOnly: tool.readOnly,
      summary: summarize(effectiveBlock),
    })
    let allowed = decision.decision === 'allow'
    let denyReason = decision.reason
    if (decision.decision === 'ask') {
      const answer = this.opts.askUser
        ? await this.opts.askUser({
            toolName: block.name,
            input: parsed.data,
            summary: summarize(effectiveBlock),
            reason: decision.reason,
          })
        : ('deny' as const)
      if (answer === 'allow-always') {
        gate.grantSession(ruleFor(effectiveBlock, toolContext.cwd))
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

    let out: ToolOutput
    try {
      out = await tool.execute(parsed.data as never, {
        ...toolContext,
        abortSignal: signal,
        toolCallId: block.id,
        toolName: block.name,
      })
    } catch (err) {
      out = { output: `${block.name} threw: ${(err as Error).message}`, isError: true }
    }
    const postEvent = out.isError ? 'PostToolUseFailure' : 'PostToolUse'
    const post = await hooks.run(postEvent, {
      toolName: block.name,
      input: effectiveInput,
      output: out.output,
      isError: out.isError,
    })
    if (pre.addedContext || post.addedContext) {
      out = {
        ...out,
        output: [
          out.output,
          pre.addedContext ? `[pre-hook context]\n${pre.addedContext}` : '',
          post.addedContext ? `[post-hook context]\n${post.addedContext}` : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
      }
    }
    if (pre.systemMessage) this.opts.bus.emit({ type: 'info', message: pre.systemMessage })
    if (post.systemMessage) this.opts.bus.emit({ type: 'info', message: post.systemMessage })
    return out
  }

  private push(m: MessageParam): void {
    this.messages.push(m)
    this.opts.onMessagesChanged?.(this.messages)
  }
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  map: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let cursor = 0
  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++
      if (index >= values.length) return
      results[index] = await map(values[index]!)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => worker()),
  )
  return results
}

function summarize(block: ToolUseBlock): string {
  const input = JSON.stringify(block.input)
  return `${block.name}(${input.length > 120 ? input.slice(0, 120) + '…' : input})`
}

/** "Always allow" rule derived from the request: Bash gets a command-prefix rule,
 *  file tools get their path in canonical-absolute form (resolved against the
 *  session cwd, forward slashes) so the grant matches however the model spells
 *  the path on later calls. */
export function ruleFor(block: ToolUseBlock, cwd: string): string {
  const obj = (block.input ?? {}) as Record<string, unknown>
  if (block.name === 'Bash' || block.name === 'PowerShell') {
    const first = String(obj['command'] ?? '').trim().split(/\s+/)[0] ?? ''
    return `${block.name}(${first}:*)`
  }
  if (typeof obj['file_path'] === 'string') {
    return `${block.name}(${resolve(cwd, String(obj['file_path'])).replaceAll('\\', '/')})`
  }
  return block.name
}

/**
 * Resume repair: for any assistant tool_use block whose id has no tool_result in
 * the immediately-following user message, synthesize an error tool_result —
 * the same block shape the abort path synthesizes mid-turn. Missing results are
 * merged into an existing partial results message, or inserted as a new user
 * message right after the assistant message.
 */
export function repairDanglingToolUses(history: MessageParam[]): MessageParam[] {
  const out: MessageParam[] = []
  for (let i = 0; i < history.length; i++) {
    const msg = history[i]!
    out.push(msg)
    if (msg.role !== 'assistant' || typeof msg.content === 'string') continue
    const toolUses = msg.content.filter(
      (b): b is ToolUseBlock => (b as { type: string }).type === 'tool_use',
    )
    if (toolUses.length === 0) continue
    const next = history[i + 1]
    const nextResultIds = new Set<string>()
    const nextHasResults = next !== undefined && next.role === 'user' && Array.isArray(next.content)
    if (nextHasResults) {
      for (const b of next.content as { type: string; tool_use_id?: string }[]) {
        if (b.type === 'tool_result' && b.tool_use_id !== undefined) nextResultIds.add(b.tool_use_id)
      }
    }
    const missing = toolUses.filter((t) => !nextResultIds.has(t.id))
    if (missing.length === 0) continue
    const synthesized: ToolResultBlockParam[] = missing.map((t) => ({
      type: 'tool_result',
      tool_use_id: t.id,
      content: 'Tool execution interrupted (session ended mid-run)',
      is_error: true,
    }))
    if (nextHasResults && nextResultIds.size > 0) {
      // The following user message already carries SOME results: merge the rest in.
      out.push({
        role: 'user',
        content: [...(next.content as ToolResultBlockParam[]), ...synthesized],
      })
      i++ // the original partial message is replaced, not re-emitted
    } else {
      out.push({ role: 'user', content: synthesized })
    }
  }
  return out
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

/** The API `input_schema` for a tool. MCP tools supply a server-authored JSON Schema
 *  verbatim (`inputSchemaJson`); everything else converts its zod `schema`. Either path
 *  guarantees a top-level object — a non-object JSON Schema degrades to an open object,
 *  mirroring zodToJsonSchema's guard. */
export function toolInputSchema(
  tool: Pick<ToolDefinition, 'schema' | 'inputSchemaJson'>,
): Tool['input_schema'] {
  if (tool.inputSchemaJson) {
    const json = tool.inputSchemaJson
    return (json['type'] === 'object' ? json : { type: 'object', properties: {} }) as Tool['input_schema']
  }
  return zodToJsonSchema(tool.schema)
}
