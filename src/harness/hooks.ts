import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import type { HookEventName, HookOutcome } from '../engine/types.js'
import type { HookDef } from '../brain/settings.js'
import { killProcessTree, makeOutputBuffer } from '../tools/shell.js'
import { assertPublicUrl, readBodyCapped } from '../tools/webfetch.js'

export interface HookEventPayload {
  toolName?: string
  input?: unknown
  output?: string
  prompt?: string
  [key: string]: unknown
}

export interface HookInvocation {
  schemaVersion: 1
  invocationId: string
  event: HookEventName
  timestamp: string
  payload: HookEventPayload
  [key: string]: unknown
}

export interface HookDecision {
  decision?: 'allow' | 'deny'
  reason?: string
  addedContext?: string
  updatedInput?: unknown
  systemMessage?: string
}

export interface HookAdapters {
  invokeMcpTool?: (
    tool: string,
    invocation: HookInvocation,
    signal: AbortSignal,
  ) => Promise<unknown>
  evaluatePrompt?: (
    prompt: string,
    invocation: HookInvocation,
    signal: AbortSignal,
  ) => Promise<unknown>
  invokeAgent?: (
    agent: string,
    prompt: string,
    invocation: HookInvocation,
    signal: AbortSignal,
  ) => Promise<unknown>
  fetch?: typeof fetch
  env?: NodeJS.ProcessEnv
}

interface HookExecutionResult {
  failed: boolean
  failure?: string
  decision?: HookDecision
}

function parseDecision(output: unknown): HookDecision {
  if (output === undefined || output === null || output === '') return {}
  if (typeof output === 'object') return output as HookDecision
  const text = String(output).trim()
  if (!text) return {}
  try {
    return JSON.parse(text) as HookDecision
  } catch {
    return { addedContext: text }
  }
}

function runProcess(
  command: string,
  payloadJson: string,
  timeoutMs: number,
  maxOutputChars: number,
): Promise<HookExecutionResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, { shell: true, windowsHide: true })
    const stdout = makeOutputBuffer(maxOutputChars)
    const stderr = makeOutputBuffer(maxOutputChars)
    let settled = false
    const finish = (result: HookExecutionResult) => {
      if (settled) return
      settled = true
      resolvePromise(result)
    }
    const timer = setTimeout(() => {
      killProcessTree(child)
      finish({ failed: true, failure: `hook timed out after ${timeoutMs}ms` })
    }, timeoutMs)
    child.stdout.on('data', (data: Buffer) => stdout.append(data.toString('utf8')))
    child.stderr.on('data', (data: Buffer) => stderr.append(data.toString('utf8')))
    child.on('error', (error) => {
      clearTimeout(timer)
      finish({ failed: true, failure: error.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 2) {
        finish({
          failed: false,
          decision: { decision: 'deny', reason: stderr.value().trim() || `hook exited ${code}` },
        })
      } else if (code !== 0) {
        finish({ failed: true, failure: `exit ${code}` })
      } else {
        finish({ failed: false, decision: parseDecision(stdout.value()) })
      }
    })
    child.stdin.on('error', () => {})
    child.stdin.write(payloadJson, () => {})
    child.stdin.end()
  })
}

async function runHttpHook(
  hook: HookDef,
  invocation: HookInvocation,
  signal: AbortSignal,
  adapters: HookAdapters,
): Promise<HookExecutionResult> {
  if (!hook.url) return { failed: true, failure: 'HTTP hook has no URL' }
  const url = new URL(hook.url)
  if (hook.allowPrivateNetwork !== true) await assertPublicUrl(url)
  const headers = new Headers({ 'content-type': 'application/json', ...(hook.headers ?? {}) })
  for (const [header, envName] of Object.entries(hook.headerEnv ?? {})) {
    const value = (adapters.env ?? process.env)[envName]
    if (!value) return { failed: true, failure: `HTTP hook requires environment variable ${envName}` }
    headers.set(header, value)
  }
  const response = await (adapters.fetch ?? fetch)(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(invocation),
    signal,
    redirect: 'error',
  })
  const body = await readBodyCapped(response, hook.maxOutputChars ?? 100_000)
  if (!response.ok) {
    return { failed: true, failure: `HTTP ${response.status}: ${body.text}` }
  }
  return { failed: false, decision: parseDecision(body.text) }
}

async function withTimeout<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await operation(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

function isGateEvent(event: HookEventName): boolean {
  return event === 'PreToolUse' || event === 'UserPromptSubmit' || event === 'PermissionRequest'
}

/** Versioned, deterministic hook dispatcher. Matching hooks run concurrently,
 * then decisions merge in declaration order; the first deny wins. */
export class HookRunner {
  private adapters: HookAdapters
  private activeAgentHook = false

  constructor(
    private readonly hooks: HookDef[],
    adapters: HookAdapters = {},
  ) {
    this.adapters = adapters
  }

  configure(adapters: HookAdapters): void {
    this.adapters = { ...this.adapters, ...adapters }
  }

  private select(event: HookEventName, toolName: string | undefined): HookDef[] {
    return this.hooks.filter((hook) => {
      if (this.activeAgentHook && hook.type === 'agent') return false
      if (hook.event !== event) return false
      if (!hook.matcher || hook.matcher === '*') return true
      if (toolName === undefined) return false
      return hook.matcher
        .split('|')
        .map((part) => part.trim())
        .includes(toolName)
    })
  }

  private async execute(hook: HookDef, invocation: HookInvocation): Promise<HookExecutionResult> {
    const timeoutMs = hook.timeoutMs ?? 60_000
    try {
      if (!hook.type || hook.type === 'command') {
        if (!hook.command) return { failed: true, failure: 'command hook has no command' }
        return runProcess(
          hook.command,
          JSON.stringify(invocation),
          timeoutMs,
          hook.maxOutputChars ?? 100_000,
        )
      }
      return await withTimeout(timeoutMs, async (signal) => {
        if (hook.type === 'http') {
          return runHttpHook(hook, invocation, signal, this.adapters)
        }
        if (hook.type === 'mcp-tool') {
          if (!hook.tool || !this.adapters.invokeMcpTool) {
            return { failed: true, failure: `MCP-tool hook adapter is unavailable (${hook.tool ?? 'unnamed'})` }
          }
          return {
            failed: false,
            decision: parseDecision(await this.adapters.invokeMcpTool(hook.tool, invocation, signal)),
          }
        }
        if (hook.type === 'prompt') {
          if (!hook.prompt || !this.adapters.evaluatePrompt) {
            return { failed: true, failure: 'prompt hook adapter is unavailable' }
          }
          return {
            failed: false,
            decision: parseDecision(
              await this.adapters.evaluatePrompt(hook.prompt, invocation, signal),
            ),
          }
        }
        if (!hook.agent || !this.adapters.invokeAgent) {
          return { failed: true, failure: 'agent hook adapter is unavailable' }
        }
        this.activeAgentHook = true
        try {
          return {
            failed: false,
            decision: parseDecision(
              await this.adapters.invokeAgent(
                hook.agent,
                hook.prompt ?? JSON.stringify(invocation.payload),
                invocation,
                signal,
              ),
            ),
          }
        } finally {
          this.activeAgentHook = false
        }
      })
    } catch (error) {
      return {
        failed: true,
        failure:
          error instanceof Error && error.name === 'AbortError'
            ? `hook timed out after ${timeoutMs}ms`
            : (error as Error).message,
      }
    }
  }

  async run(event: HookEventName, payload: HookEventPayload): Promise<HookOutcome> {
    const matching = this.select(event, payload.toolName)
    if (matching.length === 0) return { allowed: true }
    const invocation: HookInvocation = {
      schemaVersion: 1,
      invocationId: randomUUID(),
      event,
      timestamp: new Date().toISOString(),
      // Retain the legacy top-level payload fields while providing the versioned
      // nested payload contract.
      ...payload,
      payload,
    }
    const results = await Promise.all(matching.map((hook) => this.execute(hook, invocation)))
    const contexts: string[] = []
    const messages: string[] = []
    const warnings: string[] = []
    let updatedInput: unknown

    for (let index = 0; index < results.length; index++) {
      const result = results[index]!
      const hook = matching[index]!
      if (result.failed) {
        const label = `${hook.type ?? 'command'} hook failed (${result.failure ?? 'unknown failure'})`
        if (isGateEvent(event)) {
          return { allowed: false, reason: `${label}; failing closed` }
        }
        warnings.push(label)
        continue
      }
      const decision = result.decision ?? {}
      if (decision.decision === 'deny') {
        return { allowed: false, reason: decision.reason ?? `Denied by ${hook.type ?? 'command'} hook` }
      }
      if (decision.addedContext) contexts.push(decision.addedContext)
      if (decision.systemMessage) messages.push(decision.systemMessage)
      if (decision.updatedInput !== undefined) updatedInput = decision.updatedInput
    }
    return {
      allowed: true,
      reason: warnings.length ? warnings.join('; ') : undefined,
      addedContext: contexts.length ? contexts.join('\n') : undefined,
      systemMessage: messages.length ? messages.join('\n') : undefined,
      updatedInput,
    }
  }
}
