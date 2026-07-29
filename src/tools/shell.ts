import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type {
  SandboxMode,
  ToolContext,
  ToolDefinition,
  ToolOutput,
} from '../engine/types.js'

const ShellInput = z.object({
  command: z.string(),
  timeout: z.number().int().positive().max(600_000).optional(),
  run_in_background: z.boolean().optional(),
})
type ShellInputT = z.infer<typeof ShellInput>

const DEFAULT_TIMEOUT = 120_000
const OUTPUT_CAP = 30_000
const MAX_BACKGROUND_PER_OWNER = 4
const MAX_RETAINED_PER_OWNER = 32

interface ShellSpec {
  name: 'Bash' | 'PowerShell'
  bin: string
  args: (command: string) => string[]
}

function resolveBashBin(): string {
  const candidates = [
    join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
    join(process.env['LOCALAPPDATA'] ?? '', 'Programs', 'Git', 'bin', 'bash.exe'),
  ]
  for (const candidate of candidates) if (candidate && existsSync(candidate)) return candidate
  return 'bash.exe'
}

const SPECS: ShellSpec[] = [
  {
    name: 'Bash',
    bin: process.platform === 'win32' ? resolveBashBin() : 'bash',
    args: (command) => ['-c', command],
  },
  {
    name: 'PowerShell',
    bin: 'powershell.exe',
    args: (command) => ['-NoProfile', '-NonInteractive', '-Command', command],
  },
]

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

export function killProcessTree(
  child: Pick<ChildProcess, 'pid' | 'kill'>,
  platform: NodeJS.Platform = process.platform,
  spawnFn: typeof spawn = spawn,
  killFn: typeof process.kill = process.kill,
): void {
  if (platform === 'win32' && child.pid !== undefined) {
    spawnFn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on(
      'error',
      () => child.kill(),
    )
  } else if (child.pid !== undefined) {
    try {
      killFn(-child.pid, 'SIGTERM')
    } catch {
      child.kill()
    }
  } else {
    child.kill()
  }
}

function executableAvailable(command: string): boolean {
  const result =
    process.platform === 'win32'
      ? spawnSync('where.exe', [command], { stdio: 'ignore', windowsHide: true })
      : spawnSync('sh', ['-c', 'command -v "$1" >/dev/null 2>&1', 'sh', command], {
          stdio: 'ignore',
        })
  return result.status === 0
}

export function resolveSandboxedCommand(
  bin: string,
  args: string[],
  cwd: string,
  mode: SandboxMode | undefined,
  platform: NodeJS.Platform = process.platform,
  available: (command: string) => boolean = executableAvailable,
): { bin: string; args: string[] } {
  // Undefined is retained for direct library/tests that predate sandbox policy.
  if (mode === undefined || mode === 'unrestricted') return { bin, args }
  if (platform === 'linux') {
    if (!available('bwrap')) {
      throw new Error(
        `Shell denied: ${mode} needs bubblewrap (bwrap) for OS-backed containment on Linux`,
      )
    }
    const sandboxArgs = [
      '--die-with-parent',
      '--new-session',
      '--unshare-net',
      '--unshare-pid',
      '--unshare-ipc',
      '--unshare-uts',
      '--ro-bind',
      '/',
      '/',
      '--proc',
      '/proc',
      '--dev',
      '/dev',
      '--tmpfs',
      '/tmp',
    ]
    if (mode === 'workspace-write') sandboxArgs.push('--bind', cwd, cwd)
    sandboxArgs.push('--chdir', cwd, '--', bin, ...args)
    return { bin: 'bwrap', args: sandboxArgs }
  }
  if (platform === 'darwin') {
    if (!available('sandbox-exec')) {
      throw new Error(
        `Shell denied: ${mode} needs sandbox-exec for OS-backed containment on macOS`,
      )
    }
    const escaped = cwd.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
    const writeRule =
      mode === 'workspace-write' ? `(allow file-write* (subpath "${escaped}"))` : ''
    const profile =
      `(version 1)(deny default)(allow process*)(allow file-read*)${writeRule}` +
      '(deny network*)'
    return { bin: 'sandbox-exec', args: ['-p', profile, bin, ...args] }
  }
  throw new Error(
    `Shell denied: Athena has no OS-backed ${mode} process sandbox for ${platform}; ` +
      'select unrestricted explicitly to run host commands',
  )
}

interface RunShellOptions {
  onChunk?: (chunk: string) => void
  onSpawn?: (child: ChildProcess) => void
}

function runShell(
  spec: ShellSpec,
  input: ShellInputT,
  ctx: ToolContext,
  options: RunShellOptions = {},
): Promise<ToolOutput> {
  const timeout = input.timeout ?? DEFAULT_TIMEOUT
  let executable: { bin: string; args: string[] }
  try {
    executable = resolveSandboxedCommand(
      spec.bin,
      spec.args(input.command),
      ctx.cwd,
      ctx.sandboxMode,
    )
  } catch (error) {
    return Promise.resolve({ output: (error as Error).message, isError: true })
  }
  return new Promise((resolvePromise) => {
    const child = spawn(executable.bin, executable.args, {
      cwd: ctx.cwd,
      windowsHide: true,
      detached: process.platform !== 'win32',
    })
    options.onSpawn?.(child)
    const buffer = makeOutputBuffer()
    let streamed = 0
    let timedOut = false
    let settled = false
    const finish = (output: ToolOutput) => {
      if (settled) return
      settled = true
      resolvePromise(output)
    }
    const append = (data: Buffer) => {
      const chunk = data.toString('utf8')
      buffer.append(chunk)
      if (streamed < OUTPUT_CAP) {
        const bounded = chunk.slice(0, OUTPUT_CAP - streamed)
        streamed += bounded.length
        if (bounded) options.onChunk?.(bounded)
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      killProcessTree(child)
    }, timeout)
    const onAbort = () => killProcessTree(child)
    ctx.abortSignal.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    child.on('error', (error) => {
      clearTimeout(timer)
      ctx.abortSignal.removeEventListener('abort', onAbort)
      finish({
        output: `${spec.name} unavailable (${executable.bin}): ${error.message}`,
        isError: true,
      })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      ctx.abortSignal.removeEventListener('abort', onAbort)
      if (timedOut) {
        finish({
          output: `${buffer.value()}\n(command timed out after ${timeout}ms)`,
          isError: true,
        })
        return
      }
      finish({ output: buffer.value() || '(no output)', isError: code !== 0 })
    })
  })
}

export interface BackgroundTask {
  id: string
  command: string
  status: 'running' | 'done' | 'failed' | 'aborted'
  output: string
  owner?: string
  startedAt?: string
  child?: ChildProcess
  emit?: ToolContext['emit']
  terminalNotified?: boolean
}

class BackgroundTaskRegistry {
  readonly tasks = new Map<string, BackgroundTask>()

  running(owner: string): number {
    return [...this.tasks.values()].filter(
      (task) => task.owner === owner && task.status === 'running',
    ).length
  }

  prune(owner: string): void {
    const finished = [...this.tasks.values()]
      .filter((task) => task.owner === owner && task.status !== 'running')
      .sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''))
    for (const task of finished.slice(0, Math.max(0, finished.length - MAX_RETAINED_PER_OWNER))) {
      this.tasks.delete(task.id)
    }
  }

  shutdown(owner?: string): void {
    for (const task of this.tasks.values()) {
      if (owner && task.owner !== owner) continue
      if (task.status === 'running') {
        task.status = 'aborted'
        if (task.child) killProcessTree(task.child)
        task.emit?.({
          type: 'background-status',
          taskId: task.id,
          status: 'aborted',
          awaited: false,
        })
        task.terminalNotified = true
      }
      this.tasks.delete(task.id)
    }
  }
}

const taskRegistry = new BackgroundTaskRegistry()
/** Backward-compatible read surface; ownership/admission/lifecycle are enforced
 * by the registry that owns this map. */
export const backgroundTasks = taskRegistry.tasks

export function shutdownBackgroundTasks(owner?: string): void {
  taskRegistry.shutdown(owner)
}

const NOTICE_TAIL_CHARS = 1000

function makeShellTool(spec: ShellSpec): ToolDefinition<ShellInputT> {
  return {
    name: spec.name,
    description:
      `Execute a command via ${spec.name}. Host commands are OS-sandboxed in read-only/workspace-write ` +
      'modes and network-isolated. Output streams as tool progress. Background work is run-owned, capped, and cleaned up on exit.',
    schema: ShellInput,
    readOnly: false,
    async execute(input, ctx) {
      if (!input.run_in_background) {
        return runShell(spec, input, ctx, {
          onChunk: (delta) => {
            if (ctx.toolCallId) {
              ctx.emit({
                type: 'tool-progress',
                id: ctx.toolCallId,
                name: ctx.toolName ?? spec.name,
                delta,
              })
            }
          },
        })
      }

      const owner = ctx.runId ?? 'unowned'
      if (taskRegistry.running(owner) >= MAX_BACKGROUND_PER_OWNER) {
        return {
          output: `Background task limit reached (${MAX_BACKGROUND_PER_OWNER}) for run ${owner}`,
          isError: true,
        }
      }
      const id = `bg-${randomUUID().slice(0, 8)}`
      const task: BackgroundTask = {
        id,
        command: input.command,
        status: 'running',
        output: '',
        owner,
        startedAt: new Date().toISOString(),
        emit: ctx.emit,
      }
      taskRegistry.tasks.set(id, task)
      ctx.emit({ type: 'background-status', taskId: id, status: 'running', awaited: false })
      void runShell(spec, { ...input, run_in_background: false }, ctx, {
        onSpawn: (child) => {
          task.child = child
        },
        onChunk: (delta) => {
          task.output = `${task.output}${delta}`.slice(0, OUTPUT_CAP)
          ctx.emit({ type: 'background-output', taskId: id, delta })
        },
      }).then((result) => {
        if (task.status !== 'aborted') task.status = result.isError ? 'failed' : 'done'
        task.output = result.output
        if (!task.terminalNotified) {
          ctx.emit({
            type: 'background-status',
            taskId: id,
            status: task.status === 'done' ? 'completed' : task.status,
            awaited: false,
          })
          task.terminalNotified = true
        }
        const tail =
          result.output.length > NOTICE_TAIL_CHARS
            ? `…${result.output.slice(-NOTICE_TAIL_CHARS)}`
            : result.output
        ctx.emit({
          type: 'info',
          message: `Background task ${id} finished (${task.status}): ${task.command}\n${tail}`,
        })
        taskRegistry.prune(owner)
      })
      return {
        output: `Started background task ${id}: ${input.command} (poll with TaskOutput)`,
        isError: false,
      }
    },
  }
}

const TaskOutputInput = z.object({ taskId: z.string() })

export const taskOutputTool: ToolDefinition<z.infer<typeof TaskOutputInput>> = {
  name: 'TaskOutput',
  description:
    'Read a background shell task owned by this run. Finished tasks are pruned after reading.',
  schema: TaskOutputInput,
  readOnly: true,
  async execute(input, ctx) {
    const task = taskRegistry.tasks.get(input.taskId)
    const owner = ctx.runId ?? 'unowned'
    if (!task || (task.owner ?? 'unowned') !== owner) {
      const known =
        [...taskRegistry.tasks.values()]
          .filter((item) => (item.owner ?? 'unowned') === owner)
          .map((item) => item.id)
          .join(', ') || '(none)'
      return {
        output: `Unknown background task: ${input.taskId}. Known tasks: ${known}`,
        isError: true,
      }
    }
    if (task.status === 'running') {
      return {
        output: `Task ${task.id} is still running: ${task.command}\n${task.output}`,
        isError: false,
      }
    }
    taskRegistry.tasks.delete(task.id)
    ctx.emit({
      type: 'background-status',
      taskId: task.id,
      status: task.status === 'done' ? 'completed' : task.status,
      awaited: true,
    })
    return {
      output: `Task ${task.id} ${task.status} (${task.command})\n${task.output}`,
      isError: task.status === 'failed' || task.status === 'aborted',
    }
  },
}

export const bashTool = makeShellTool(SPECS[0]!)
export const powershellTool = makeShellTool(SPECS[1]!)
