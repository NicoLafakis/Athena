// src/engine/types.ts
import type { z } from 'zod'
import type { ProviderId } from '../brain/models.js'

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens?: number
  costUsd?: number
  modelCalls?: number
  toolCalls?: number
  turns?: number
  durationMs?: number
}

export interface RunUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd: number
  modelCalls: number
  toolCalls: number
  turns: number
  durationMs: number
}

export interface RunLimits {
  maxTurns?: number
  maxModelCalls?: number
  maxToolCalls?: number
  maxTokens?: number
  maxCostUsd?: number
  maxDurationMs?: number
  maxConcurrency?: number
}

export interface RunResult {
  status: 'completed' | 'limit' | 'aborted' | 'error'
  reason: string
  usage: RunUsage
}

export type EngineEvent =
  | { type: 'assistant-text'; delta: string }
  | { type: 'assistant-thinking'; delta: string }
  | { type: 'tool-request'; id: string; name: string; input: unknown }
  | { type: 'tool-progress'; id: string; name: string; delta: string }
  | { type: 'background-output'; taskId: string; delta: string }
  | { type: 'tool-result'; id: string; name: string; output: string; isError: boolean }
  | { type: 'todo-update'; todos: TodoItem[] }
  | { type: 'turn-done'; usage: TokenUsage }
  | { type: 'turn-start'; turn: number }
  | { type: 'run-limit'; limit: string; usage: RunUsage }
  | {
      type: 'child-status'
      runId: string
      agent: string
      status: 'running' | 'completed' | 'failed' | 'aborted' | 'limit'
      usage?: RunUsage
    }
  | { type: 'child-text'; runId: string; agent: string; delta: string }
  | { type: 'child-tool-request'; runId: string; agent: string; id: string; name: string; input: unknown }
  | {
      type: 'child-tool-result'
      runId: string
      agent: string
      id: string
      name: string
      output: string
      isError: boolean
    }
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

export type ToolResultContent =
  | string
  | Array<
      | { type: 'text'; text: string }
      | {
          type: 'image'
          source: {
            type: 'base64'
            media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
            data: string
          }
        }
    >

export interface ToolOutput {
  output: string
  isError: boolean
  /** Optional provider-native content. Events/TUI receive the bounded textual
   * summary while the model receives this richer result. */
  content?: ToolResultContent
}

export interface ToolContext {
  cwd: string
  brainDir: string
  projectBrainDir: string | null
  fileReadRegistry: Set<string>
  fileReadHashes?: Map<string, string>
  todos: TodoItem[]
  emit: (event: EngineEvent) => void
  abortSignal: AbortSignal
  resolvePath?: (path: string, access: 'read' | 'write') => string
  sandboxMode?: SandboxMode
  runId?: string
  toolCallId?: string
  toolName?: string
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
  /** Whether multiple calls may execute concurrently without shared-write
   * conflicts. Omitted means the tool's readOnly value. */
  concurrencySafe?: (input: unknown) => boolean
  execute(input: I, ctx: ToolContext): Promise<ToolOutput>
}

export type PermissionMode = 'normal' | 'acceptEdits' | 'plan' | 'trusted'
export type SandboxMode = 'read-only' | 'workspace-write' | 'unrestricted'

export interface PermissionRequest { toolName: string; input: unknown; readOnly: boolean; summary: string }

export type PermissionDecision =
  | { decision: 'allow'; reason: string }
  | { decision: 'deny'; reason: string }
  | { decision: 'ask'; reason: string }

export interface PermissionGate {
  check(req: PermissionRequest): PermissionDecision
  grantSession(rule: string): void
}

export type HookEventName =
  | 'SessionStart'
  | 'SessionEnd'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'PermissionRequest'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'PreCompact'
  | 'PostCompact'
  | 'Notification'
  | 'Stop'

export interface HookOutcome {
  allowed: boolean
  reason?: string
  addedContext?: string
  updatedInput?: unknown
  systemMessage?: string
}
