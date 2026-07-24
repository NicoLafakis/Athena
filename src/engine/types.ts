// src/engine/types.ts
import type { z } from 'zod'
import type { ProviderId } from '../brain/models.js'

export interface TokenUsage { inputTokens: number; outputTokens: number; cacheReadTokens: number }

export type EngineEvent =
  | { type: 'assistant-text'; delta: string }
  | { type: 'assistant-thinking'; delta: string }
  | { type: 'tool-request'; id: string; name: string; input: unknown }
  | { type: 'tool-result'; id: string; name: string; output: string; isError: boolean }
  | { type: 'todo-update'; todos: TodoItem[] }
  | { type: 'turn-done'; usage: TokenUsage }
  | { type: 'compaction'; summary: string }
  | { type: 'info'; message: string } // system transcript note (slash-command output etc.)
  | { type: 'error'; message: string; fatal: boolean }
  | {
      type: 'status'
      patch: {
        model?: string
        modelKey?: string
        provider?: ProviderId
        effort?: string
        mode?: PermissionMode
        contextPct?: number
      }
    }

export interface TodoItem { text: string; status: 'pending' | 'in_progress' | 'done' }

export interface ToolOutput { output: string; isError: boolean }

export interface ToolContext {
  cwd: string
  brainDir: string
  projectBrainDir: string | null
  fileReadRegistry: Set<string>
  todos: TodoItem[]
  emit: (event: EngineEvent) => void
  abortSignal: AbortSignal
}

export interface ToolDefinition<I = unknown> {
  name: string
  description: string
  schema: z.ZodType<I>
  /** When present, used verbatim as the API `input_schema` instead of converting `schema`.
   *  MCP tools carry a server-authored JSON Schema (not zod); this is the schema the model
   *  sees, while `schema` stays a permissive local-validation passthrough. */
  inputSchemaJson?: Record<string, unknown>
  readOnly: boolean
  execute(input: I, ctx: ToolContext): Promise<ToolOutput>
}

export type PermissionMode = 'normal' | 'acceptEdits' | 'plan' | 'trusted'

export interface PermissionRequest { toolName: string; input: unknown; readOnly: boolean; summary: string }

export type PermissionDecision =
  | { decision: 'allow'; reason: string }
  | { decision: 'deny'; reason: string }
  | { decision: 'ask'; reason: string }

export interface PermissionGate {
  check(req: PermissionRequest): PermissionDecision
  grantSession(rule: string): void
}

export type HookEventName = 'SessionStart' | 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse' | 'Stop'

export interface HookOutcome { allowed: boolean; reason?: string; addedContext?: string }
