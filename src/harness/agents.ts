import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages'
import { Engine } from '../engine/loop.js'
import { EngineEventBus } from '../engine/events.js'
import { ContextManager } from '../engine/context.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { HookRunner } from './hooks.js'
import type { ModelClient } from '../engine/client.js'
import type { AgentDef } from '../brain/loader.js'
import {
  modelCapabilities,
  normalizeModel,
  type ProviderId,
  type ModelKey,
  type Effort,
} from '../brain/models.js'
import type {
  PermissionGate,
  RunLimits,
  RunUsage,
  ToolContext,
  ToolOutput,
} from '../engine/types.js'
import { atomicWriteFile } from '../tools/files.js'
import { RunTraceWriter } from './traces.js'
import { ResourcePolicy } from './resource-policy.js'
import { redactSessionValue } from './sessions.js'

export interface AgentOrchestratorOptions {
  defs: AgentDef[]
  clientFactory: () => ModelClient
  baseRegistry: ToolRegistry
  gate: PermissionGate
  hooks: HookRunner
  defaultModel: () => ModelKey
  defaultProvider?: () => ProviderId
  defaultEffort: () => Effort
  systemPromptBase: string
  runStoreDir?: string
  traceRootDir?: string
  limits?: RunLimits
}

export interface ChildRunRecord {
  version: 1
  runId: string
  agent: string
  isolation?: 'shared' | 'worktree'
  prompt: string
  status: 'running' | 'completed' | 'failed' | 'aborted' | 'limit'
  messages: MessageParam[]
  usage: RunUsage | null
  createdAt: string
  updatedAt: string
}

export interface AgentRunOutput extends ToolOutput {
  /** Durable identifier exposed separately so callers do not have to parse or
   * strip observability metadata from the agent's user-visible answer. */
  runId?: string
}

const DEFAULT_CHILD_LIMITS: RunLimits = {
  maxModelCalls: 50,
  maxToolCalls: 100,
  maxTokens: 1_000_000,
  maxCostUsd: 5,
  maxDurationMs: 30 * 60_000,
  maxConcurrency: 2,
}

function git(cwd: string, args: string[], input?: string, trim = true): string {
  const result = spawnSync('git', args, {
    cwd,
    input,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024,
  })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`)
  return trim ? result.stdout.trim() : result.stdout
}

class ChildWorkspace {
  private constructor(
    readonly cwd: string,
    private readonly worktree: string,
    private readonly repository: string,
  ) {}

  static async create(cwd: string): Promise<ChildWorkspace> {
    const repository = git(cwd, ['rev-parse', '--show-toplevel'])
    if (git(repository, ['status', '--porcelain'])) {
      throw new Error('worktree-isolated agents require a clean parent worktree')
    }
    const directory = await mkdtemp(join(tmpdir(), 'athena-agent-worktree-'))
    try {
      git(repository, ['worktree', 'add', '--detach', directory, 'HEAD'])
      const subdirectory = relative(repository, resolve(cwd))
      return new ChildWorkspace(
        subdirectory ? join(directory, subdirectory) : directory,
        directory,
        repository,
      )
    } catch (error) {
      await rm(directory, { recursive: true, force: true })
      throw error
    }
  }

  patch(): string {
    // Intent-to-add exposes untracked child files in the binary diff without
    // committing or touching the parent index.
    git(this.worktree, ['add', '--intent-to-add', '.'])
    return git(this.worktree, ['diff', '--binary', '--no-ext-diff'], undefined, false)
  }

  async close(): Promise<void> {
    try {
      git(this.repository, ['worktree', 'remove', '--force', this.worktree])
    } finally {
      await rm(this.worktree, { recursive: true, force: true })
      try {
        git(this.repository, ['worktree', 'prune'])
      } catch {
        // Best effort.
      }
    }
  }

  merge(patch: string): void {
    if (!patch.trim()) return
    const apply = ['-c', 'core.autocrlf=false', 'apply', '--whitespace=error-all', '-']
    git(this.repository, [...apply.slice(0, 4), '--check', ...apply.slice(4)], patch)
    git(this.repository, apply, patch)
  }
}

export class AgentOrchestrator {
  private readonly records = new Map<string, ChildRunRecord>()
  private mergeQueue: Promise<void> = Promise.resolve()

  constructor(private readonly opts: AgentOrchestratorOptions) {}

  listDefs(): AgentDef[] {
    return this.opts.defs
  }

  getDef(name: string): AgentDef | undefined {
    return this.opts.defs.find((definition) => definition.name === name)
  }

  buildChildRegistry(def: AgentDef): ToolRegistry {
    let names = def.tools
    if (
      names !== null &&
      names.some((name) => name === 'Bash' || name === 'PowerShell') &&
      !names.includes('TaskOutput')
    ) {
      names = [...names, 'TaskOutput']
    }
    return this.opts.baseRegistry.restrict(names, ['Agent'])
  }

  isConcurrencySafe(def: AgentDef): boolean {
    return (
      def.isolation === 'worktree' ||
      this.buildChildRegistry(def).list().every((tool) => tool.readOnly)
    )
  }

  async runAgent(def: AgentDef, prompt: string, parentCtx: ToolContext): Promise<AgentRunOutput> {
    return this.execute(def, prompt, parentCtx)
  }

  async followUp(runId: string, prompt: string, parentCtx: ToolContext): Promise<AgentRunOutput> {
    const record = await this.loadRecord(runId)
    if (!record) return { output: `Unknown agent run "${runId}"`, isError: true }
    if (record.status === 'running') {
      return { output: `Agent run ${runId} is still running`, isError: true }
    }
    const def = this.getDef(record.agent)
    if (!def) {
      return { output: `Agent definition "${record.agent}" is no longer available`, isError: true }
    }
    return this.execute(def, prompt, parentCtx, record)
  }

  async status(runId: string): Promise<ToolOutput> {
    const record = await this.loadRecord(runId)
    if (!record) return { output: `Unknown agent run "${runId}"`, isError: true }
    return { output: JSON.stringify(record, null, 2), isError: record.status === 'failed' }
  }

  async listRuns(): Promise<ToolOutput> {
    if (this.opts.runStoreDir && existsSync(this.opts.runStoreDir)) {
      for (const file of await readdir(this.opts.runStoreDir)) {
        const match = /^([A-Za-z0-9-]+)\.json$/.exec(file)
        if (match) await this.loadRecord(match[1]!)
      }
    }
    const runs = [...this.records.values()].map(({ messages: _messages, ...record }) => record)
    return { output: JSON.stringify(runs, null, 2), isError: false }
  }

  private async execute(
    def: AgentDef,
    prompt: string,
    parentCtx: ToolContext,
    previous?: ChildRunRecord,
  ): Promise<AgentRunOutput> {
    if (parentCtx.abortSignal.aborted) {
      return { output: `Agent ${def.name} aborted before start`, isError: true }
    }
    const startHook = await this.opts.hooks.run('SubagentStart', {
      agent: def.name,
      isolation: def.isolation ?? 'shared',
      prompt,
      resumedRunId: previous?.runId,
    })
    if (!startHook.allowed) {
      return {
        output: `Agent ${def.name} blocked by SubagentStart hook: ${startHook.reason ?? 'no reason given'}`,
        isError: true,
      }
    }
    const effectivePrompt = startHook.addedContext
      ? `${prompt}\n\n<hook-context>\n${startHook.addedContext}\n</hook-context>`
      : prompt
    const runId = previous?.runId ?? randomUUID()
    const now = new Date().toISOString()
    const record: ChildRunRecord = {
      version: 1,
      runId,
      agent: def.name,
      isolation: def.isolation ?? 'shared',
      prompt,
      status: 'running',
      messages: previous?.messages ?? [],
      usage: previous?.usage ?? null,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    }
    this.records.set(runId, record)
    await this.saveRecord(record)
    parentCtx.emit({ type: 'child-status', runId, agent: def.name, status: 'running' })

    const bus = new EngineEventBus()
    let finalText = ''
    let fatalError: string | null = null
    bus.on((event) => {
      if (event.type === 'assistant-text') {
        finalText += event.delta
        parentCtx.emit({ type: 'child-text', runId, agent: def.name, delta: event.delta })
      }
      if (event.type === 'tool-request') {
        parentCtx.emit({
          type: 'child-tool-request',
          runId,
          agent: def.name,
          id: event.id,
          name: event.name,
          input: event.input,
        })
      }
      if (event.type === 'tool-result') {
        parentCtx.emit({
          type: 'child-tool-result',
          runId,
          agent: def.name,
          id: event.id,
          name: event.name,
          output: event.output,
          isError: event.isError,
        })
      }
      if (event.type === 'error' && event.fatal) fatalError = event.message
    })
    const provider = this.opts.defaultProvider?.() ?? 'anthropic'
    const model = normalizeModel(provider, def.model ?? '') ?? this.opts.defaultModel()
    const capabilities = modelCapabilities(provider, model)
    const trace = this.opts.traceRootDir
      ? await RunTraceWriter.create(this.opts.traceRootDir, {
          cwd: parentCtx.cwd,
          provider,
          model,
          mode: 'inherited',
          sandbox: parentCtx.sandboxMode ?? 'workspace-write',
          parentRunId: parentCtx.runId,
          runId,
        })
      : null
    trace?.attach(bus)
    trace?.recordPrompt(effectivePrompt)
    let workspace: ChildWorkspace | null = null
    let childContext = parentCtx
    if (def.isolation === 'worktree') {
      try {
        workspace = await ChildWorkspace.create(parentCtx.cwd)
        const policy = new ResourcePolicy(
          workspace.cwd,
          parentCtx.sandboxMode ?? 'workspace-write',
          [parentCtx.brainDir],
        )
        childContext = {
          ...parentCtx,
          cwd: workspace.cwd,
          resolvePath: (path, access) => policy.resolvePath(path, access),
        }
      } catch (error) {
        record.status = 'failed'
        record.updatedAt = new Date().toISOString()
        await this.saveRecord(record)
        parentCtx.emit({ type: 'child-status', runId, agent: def.name, status: 'failed' })
        await trace?.close({
          status: 'error',
          reason: (error as Error).message,
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            costUsd: 0,
            modelCalls: 0,
            toolCalls: 0,
            turns: 0,
            durationMs: 0,
          },
        })
        return {
          output: `Agent isolation failed: ${(error as Error).message}`,
          isError: true,
          runId,
        }
      }
    }
    const engine = new Engine({
      client: this.opts.clientFactory(),
      bus,
      registry: this.buildChildRegistry(def),
      gate: this.opts.gate,
      hooks: this.opts.hooks,
      contextManager: new ContextManager({
        modelWindowTokens: capabilities.contextWindowTokens,
      }),
      toolContext: {
        ...childContext,
        todos: [],
        fileReadRegistry: new Set(),
        fileReadHashes: new Map(),
        emit: (event) => bus.emit(event),
        runId,
      },
      provider,
      model,
      effort: this.opts.defaultEffort(),
      systemPrompt: `${this.opts.systemPromptBase}\n\n---\n\n# Agent: ${def.name}\n\n${def.systemPrompt}`,
      maxTokens: capabilities.maxOutputTokens,
      preflightContext: true,
      limits: { ...DEFAULT_CHILD_LIMITS, ...this.opts.limits, ...def.limits },
    })
    if (record.messages.length > 0) engine.loadMessages(record.messages)
    const onParentAbort = () => engine.abort()
    parentCtx.abortSignal.addEventListener('abort', onParentAbort)
    let result
    try {
      result = await engine.runTurn(effectivePrompt)
    } finally {
      parentCtx.abortSignal.removeEventListener('abort', onParentAbort)
    }
    if (workspace) {
      const isolated = workspace
      try {
        const patch = isolated.patch()
        await isolated.close()
        workspace = null
        if (result.status === 'completed' && !fatalError && patch.trim()) {
          const merge = this.mergeQueue.then(() => {
            isolated.merge(patch)
          })
          // Keep the queue alive after a failed merge while surfacing this merge's
          // failure to the child run.
          this.mergeQueue = merge.catch(() => {})
          await merge
        }
      } catch (error) {
        fatalError = `isolated worktree merge failed: ${(error as Error).message}`
      } finally {
        await workspace?.close().catch(() => {})
      }
    }
    await trace?.close(result)

    record.messages = structuredClone(engine.getMessages())
    record.usage = result.usage
    record.updatedAt = new Date().toISOString()
    record.status =
      result.status === 'completed'
        ? fatalError
          ? 'failed'
          : 'completed'
        : result.status === 'error'
          ? 'failed'
          : result.status
    await this.saveRecord(record)
    parentCtx.emit({
      type: 'child-status',
      runId,
      agent: def.name,
      status: record.status,
      usage: result.usage,
    })
    await this.opts.hooks.run('SubagentStop', {
      runId,
      agent: def.name,
      status: record.status,
      usage: result.usage,
    })

    if (fatalError !== null) {
      return {
        output: `Agent ${def.name} failed: ${fatalError as string}`,
        isError: true,
        runId,
      }
    }
    if (record.status === 'aborted' || record.status === 'limit') {
      return {
        output: `Agent ${def.name} ${record.status}: ${result.reason}`,
        isError: true,
        runId,
      }
    }
    const last = [...engine.getMessages()].reverse().find((message) => message.role === 'assistant')
    const text = extractText(last) || finalText
    return {
      output: text.trim() || `(agent ${def.name} produced no text)`,
      isError: false,
      runId,
    }
  }

  private async loadRecord(runId: string): Promise<ChildRunRecord | null> {
    const inMemory = this.records.get(runId)
    if (inMemory) return inMemory
    if (!this.opts.runStoreDir || !/^[A-Za-z0-9-]+$/.test(runId)) return null
    const file = join(this.opts.runStoreDir, `${runId}.json`)
    if (!existsSync(file)) return null
    const record = JSON.parse(await readFile(file, 'utf8')) as ChildRunRecord
    this.records.set(runId, record)
    return record
  }

  private async saveRecord(record: ChildRunRecord): Promise<void> {
    if (!this.opts.runStoreDir) return
    await atomicWriteFile(
      join(this.opts.runStoreDir, `${record.runId}.json`),
      JSON.stringify(redactSessionValue(record), null, 2) + '\n',
    )
  }
}

function extractText(message: MessageParam | undefined): string {
  if (!message) return ''
  if (typeof message.content === 'string') return message.content
  return message.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('')
}
