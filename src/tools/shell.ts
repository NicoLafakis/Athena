import { spawn, type ChildProcess } from 'node:child_process'
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

/** Bounded output accumulator: stops buffering once the cap is reached, so a
 *  runaway command cannot OOM the harness while it streams gigabytes. */
export function makeOutputBuffer(capChars = OUTPUT_CAP): {
  append(chunk: string): void
  value(): string
  readonly truncated: boolean
} {
  let out = ''
  let truncated = false
  return {
    append(chunk: string) {
      if (truncated) return
      out += chunk
      if (out.length > capChars) {
        out = out.slice(0, capChars)
        truncated = true
      }
    },
    value() {
      return truncated ? out + `\n(truncated: output exceeded ${capChars} chars)` : out
    },
    get truncated() {
      return truncated
    },
  }
}

/** Kill a spawned command. On win32 `child.kill()` only signals the direct
 *  child and orphans grandchildren (e.g. node started by a .cmd shim), so use
 *  `taskkill /T /F` on the process tree; elsewhere a signal suffices.
 *  `platform`/`spawnFn` are injectable for tests. */
export function killProcessTree(
  child: Pick<ChildProcess, 'pid' | 'kill'>,
  platform: NodeJS.Platform = process.platform,
  spawnFn: typeof spawn = spawn,
): void {
  if (platform === 'win32' && child.pid !== undefined) {
    spawnFn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on(
      'error',
      () => child.kill(),
    )
  } else {
    child.kill()
  }
}

function runShell(spec: ShellSpec, input: ShellInputT, ctx: ToolContext): Promise<ToolOutput> {
  const timeout = input.timeout ?? DEFAULT_TIMEOUT
  return new Promise((resolvePromise) => {
    const child = spawn(spec.bin, spec.args(input.command), { cwd: ctx.cwd, windowsHide: true })
    const buf = makeOutputBuffer()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      killProcessTree(child)
    }, timeout)
    const onAbort = () => killProcessTree(child)
    ctx.abortSignal.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (d: Buffer) => {
      buf.append(d.toString('utf8'))
    })
    child.stderr.on('data', (d: Buffer) => {
      buf.append(d.toString('utf8'))
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
          output: buf.value() + `\n(command timed out after ${timeout}ms)`,
          isError: true,
        })
        return
      }
      resolvePromise({ output: buf.value() || '(no output)', isError: code !== 0 })
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

/** Tail shown in the completion notice; full output stays readable via TaskOutput. */
const NOTICE_TAIL_CHARS = 1000

function makeShellTool(spec: ShellSpec): ToolDefinition<ShellInputT> {
  return {
    name: spec.name,
    description: `Execute a command via ${spec.name}. Default timeout 120s, max 600s. Set run_in_background for long-running commands; you get a task id back, completion is announced as a system notice, and the captured output can be read with the TaskOutput tool.`,
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
        // An info notice, NOT a tool-result: a tool-result here would be an
        // orphan (no matching tool_use id in the transcript or the TUI).
        const tail =
          res.output.length > NOTICE_TAIL_CHARS
            ? `…${res.output.slice(-NOTICE_TAIL_CHARS)}`
            : res.output
        ctx.emit({
          type: 'info',
          message: `Background task ${id} finished (${task.status}): ${task.command}\n${tail}`,
        })
      })
      return {
        output: `Started background task ${id}: ${input.command} (poll with TaskOutput)`,
        isError: false,
      }
    },
  }
}

const TaskOutputInput = z.object({ taskId: z.string() })

/** Read-only poll over backgroundTasks so the model can retrieve background
 *  shell results. Finished entries are pruned once read (bounded map). */
export const taskOutputTool: ToolDefinition<z.infer<typeof TaskOutputInput>> = {
  name: 'TaskOutput',
  description:
    'Read the status and captured output of a background shell task by id (bg-xxxx). Finished tasks are removed from the registry once read.',
  schema: TaskOutputInput,
  readOnly: true,
  async execute(input) {
    const task = backgroundTasks.get(input.taskId)
    if (!task) {
      const known = [...backgroundTasks.keys()].join(', ') || '(none)'
      return { output: `Unknown background task: ${input.taskId}. Known tasks: ${known}`, isError: true }
    }
    if (task.status === 'running') {
      return { output: `Task ${task.id} is still running: ${task.command}`, isError: false }
    }
    backgroundTasks.delete(task.id) // prune once read
    return {
      output: `Task ${task.id} ${task.status} (${task.command})\n${task.output}`,
      isError: task.status === 'failed',
    }
  },
}

export const bashTool = makeShellTool(SPECS[0]!)
export const powershellTool = makeShellTool(SPECS[1]!)
