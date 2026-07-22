import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { ToolDefinition, ToolOutput, ToolContext } from '../engine/types.js'

const ShellInput = z.object({
  command: z.string(),
  timeout: z.number().int().positive().max(600_000).optional(),
  run_in_background: z.boolean().optional(),
})
type ShellInputT = z.infer<typeof ShellInput>

const DEFAULT_TIMEOUT = 120_000
const OUTPUT_CAP = 30_000

interface ShellSpec {
  name: 'Bash' | 'PowerShell'
  bin: string
  args: (cmd: string) => string[]
}

/** bash.exe is often absent from PATH on Windows; probe standard Git-for-Windows installs. */
function resolveBashBin(): string {
  const candidates = [
    join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
    join(process.env['LOCALAPPDATA'] ?? '', 'Programs', 'Git', 'bin', 'bash.exe'),
  ]
  for (const c of candidates) if (c && existsSync(c)) return c
  return 'bash.exe' // fall back to PATH; spawn error surfaces as "Bash unavailable"
}

const SPECS: ShellSpec[] = [
  { name: 'Bash', bin: process.platform === 'win32' ? resolveBashBin() : 'bash', args: (cmd) => ['-c', cmd] },
  {
    name: 'PowerShell',
    bin: 'powershell.exe',
    args: (cmd) => ['-NoProfile', '-NonInteractive', '-Command', cmd],
  },
]

function cap(s: string): string {
  return s.length > OUTPUT_CAP
    ? s.slice(0, OUTPUT_CAP) + `\n(truncated: output exceeded ${OUTPUT_CAP} chars)`
    : s
}

function runShell(spec: ShellSpec, input: ShellInputT, ctx: ToolContext): Promise<ToolOutput> {
  const timeout = input.timeout ?? DEFAULT_TIMEOUT
  return new Promise((resolvePromise) => {
    const child = spawn(spec.bin, spec.args(input.command), { cwd: ctx.cwd, windowsHide: true })
    let out = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeout)
    const onAbort = () => child.kill()
    ctx.abortSignal.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString('utf8')
    })
    child.stderr.on('data', (d: Buffer) => {
      out += d.toString('utf8')
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      ctx.abortSignal.removeEventListener('abort', onAbort)
      resolvePromise({ output: `${spec.name} unavailable (${spec.bin}): ${e.message}`, isError: true })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      ctx.abortSignal.removeEventListener('abort', onAbort)
      if (timedOut) {
        resolvePromise({
          output: cap(out) + `\n(command timed out after ${timeout}ms)`,
          isError: true,
        })
        return
      }
      resolvePromise({ output: cap(out) || '(no output)', isError: code !== 0 })
    })
  })
}

export interface BackgroundTask {
  id: string
  command: string
  status: 'running' | 'done' | 'failed'
  output: string
}
export const backgroundTasks = new Map<string, BackgroundTask>()

function makeShellTool(spec: ShellSpec): ToolDefinition<ShellInputT> {
  return {
    name: spec.name,
    description: `Execute a command via ${spec.name}. Default timeout 120s, max 600s. Set run_in_background for long-running commands; completion is reported as a tool-result event.`,
    schema: ShellInput,
    readOnly: false,
    async execute(input, ctx) {
      if (!input.run_in_background) return runShell(spec, input, ctx)
      const id = `bg-${randomUUID().slice(0, 8)}`
      const task: BackgroundTask = { id, command: input.command, status: 'running', output: '' }
      backgroundTasks.set(id, task)
      void runShell(spec, { ...input, run_in_background: false }, ctx).then((res) => {
        task.status = res.isError ? 'failed' : 'done'
        task.output = res.output
        ctx.emit({
          type: 'tool-result',
          id,
          name: spec.name,
          output: `[background ${id} ${task.status}]\n${res.output}`,
          isError: res.isError,
        })
      })
      return { output: `Started background task ${id}: ${input.command}`, isError: false }
    },
  }
}

export const bashTool = makeShellTool(SPECS[0]!)
export const powershellTool = makeShellTool(SPECS[1]!)
