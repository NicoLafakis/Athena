import { spawn } from 'node:child_process'
import type { HookEventName, HookOutcome } from '../engine/types.js'
import type { HookDef } from '../brain/settings.js'

export interface HookEventPayload {
  toolName?: string
  input?: unknown
  output?: string
  prompt?: string
  [k: string]: unknown
}

interface HookProcessResult {
  code: number | null
  stdout: string
  stderr: string
  failed: boolean
  failure?: string
}

function runProcess(command: string, payloadJson: string, timeoutMs: number): Promise<HookProcessResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, { shell: true, windowsHide: true })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (r: HookProcessResult) => {
      if (!settled) {
        settled = true
        resolvePromise(r)
      }
    }
    const timer = setTimeout(() => {
      child.kill()
      finish({ code: null, stdout, stderr, failed: true, failure: `hook timed out after ${timeoutMs}ms` })
    }, timeoutMs)
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8')
    })
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8')
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      finish({ code: null, stdout, stderr, failed: true, failure: e.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      finish({ code, stdout, stderr, failed: false })
    })
    child.stdin.write(payloadJson)
    child.stdin.end()
  })
}

export class HookRunner {
  constructor(private readonly hooks: HookDef[]) {}

  private select(event: HookEventName, toolName: string | undefined): HookDef[] {
    return this.hooks.filter((h) => {
      if (h.event !== event) return false
      if (!h.matcher || h.matcher === '*') return true
      if (toolName === undefined) return true
      return h.matcher
        .split('|')
        .map((s) => s.trim())
        .includes(toolName)
    })
  }

  /** Runs every matching hook in declaration order. First deny wins. addedContext concatenates. */
  async run(event: HookEventName, payload: HookEventPayload): Promise<HookOutcome> {
    const matching = this.select(event, payload.toolName)
    const contexts: string[] = []
    const warnings: string[] = []
    const json = JSON.stringify({ event, ...payload })
    for (const hookDef of matching) {
      const result = await runProcess(hookDef.command, json, hookDef.timeoutMs)
      const processFailed = result.failed || (result.code !== 0 && result.code !== 2)
      if (processFailed) {
        if (event === 'PreToolUse') {
          // A broken gate blocks, not bypasses.
          return {
            allowed: false,
            reason: `PreToolUse hook failed (${result.failure ?? `exit ${result.code}`}); failing closed. Command: ${hookDef.command}`,
          }
        }
        warnings.push(`hook failed (${result.failure ?? `exit ${result.code}`}): ${hookDef.command}`)
        continue
      }
      if (result.code === 2) {
        return { allowed: false, reason: result.stderr.trim() || `Denied by hook: ${hookDef.command}` }
      }
      // exit 0: optional stdout JSON annotation
      const trimmed = result.stdout.trim()
      if (trimmed) {
        try {
          const parsed = JSON.parse(trimmed) as { addedContext?: string }
          if (parsed.addedContext) contexts.push(parsed.addedContext)
        } catch {
          /* non-JSON stdout is ignored */
        }
      }
    }
    return {
      allowed: true,
      reason: warnings.length ? `hook failed (fail-open): ${warnings.join('; ')}` : undefined,
      addedContext: contexts.length ? contexts.join('\n') : undefined,
    }
  }
}
