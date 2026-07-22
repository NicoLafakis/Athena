// src/engine/context.ts
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages'
import type { TokenUsage } from './types.js'

export type Summarizer = (prompt: string) => Promise<string>

export interface ContextManagerOptions {
  modelWindowTokens: number
  compactionThreshold?: number // fraction of window; default 0.8
  keepRecentMessages?: number // tail kept verbatim; default 6
}

export class ContextManager {
  private readonly windowTokens: number
  private readonly threshold: number
  private readonly keepRecent: number
  private lastTotal = 0

  constructor(opts: ContextManagerOptions) {
    this.windowTokens = opts.modelWindowTokens
    this.threshold = opts.compactionThreshold ?? 0.8
    // Guard: keepRecentMessages <= 0 would make slice(-0) keep everything (no compaction at all).
    this.keepRecent = Math.max(1, opts.keepRecentMessages ?? 6)
  }

  /** Called with the usage block of each API response; input tokens already include the whole transcript. */
  update(usage: TokenUsage): void {
    this.lastTotal = usage.inputTokens + usage.cacheReadTokens + usage.outputTokens
  }

  usedFraction(): number {
    return this.lastTotal / this.windowTokens
  }

  needsCompaction(): boolean {
    return this.lastTotal >= this.threshold * this.windowTokens
  }

  buildSummaryPrompt(older: MessageParam[]): string {
    const transcript = older
      .map((m) => `[${m.role}] ${serializeContent(m.content)}`)
      .join('\n')
    return [
      'Summarize the following conversation transcript into a compact hand-forward for a coding agent.',
      'You MUST preserve, as explicit sections:',
      '1. **Decisions made this session** — every decision, with its rationale in one line.',
      '2. **Files modified** — every file created, edited, or deleted, with a one-line description of the change.',
      '3. **Current state and next steps** — where the work stands and what remains.',
      'Do not restate the constitution or system rules; they are provided separately.',
      'Be dense. Omit pleasantries and tool noise.',
      '',
      '--- TRANSCRIPT ---',
      transcript,
    ].join('\n')
  }

  /** Replaces everything but the recent tail with one summary user message. Constitution survives in the system prompt untouched. */
  async compact(
    messages: MessageParam[],
    summarize: Summarizer,
  ): Promise<{ messages: MessageParam[]; summary: string }> {
    if (messages.length <= this.keepRecent) return { messages, summary: '' }
    // Naive cut point by message count, then walked forward so the kept tail never starts
    // with a message carrying tool_result blocks whose tool_use was summarized away
    // (an orphaned tool_result makes the API reject the request with a 400).
    let cut = messages.length - this.keepRecent
    while (cut < messages.length && hasToolResult(messages[cut]!)) cut += 1
    if (cut >= messages.length) return { messages, summary: '' } // no clean boundary; skip compaction
    const tail = messages.slice(cut)
    const older = messages.slice(0, cut)
    const summary = await summarize(this.buildSummaryPrompt(older))
    const summaryMessage: MessageParam = {
      role: 'user',
      content: `[Context compacted. Summary of the earlier conversation:]\n\n${summary}`,
    }
    this.lastTotal = 0 // stale until the next API response reports real usage
    return { messages: [summaryMessage, ...tail], summary }
  }
}

/** Max characters a single content block contributes to the summarization prompt. */
const MAX_BLOCK_CHARS = 2000

function hasToolResult(message: MessageParam): boolean {
  if (typeof message.content === 'string') return false
  return message.content.some((b) => b.type === 'tool_result')
}

/** Serializes message content for the summary prompt, truncating each block so one
 *  giant tool output cannot overflow the summarization request itself. */
function serializeContent(content: MessageParam['content']): string {
  if (typeof content === 'string') return content
  return content
    .map((block) => {
      const json = JSON.stringify(block)
      return json.length > MAX_BLOCK_CHARS ? `${json.slice(0, MAX_BLOCK_CHARS)}…[truncated]` : json
    })
    .join(' ')
}
