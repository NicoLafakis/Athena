// src/harness/controller.ts — Shared Athena Harness Session Controller for CLI exec, voice, and headless runs.
import { execSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { BrainPaths } from '../brain/paths.js'
import type { ProviderId, Effort } from '../brain/models.js'
import { modelCapabilities } from '../brain/models.js'
import type { Settings } from '../brain/settings.js'
import { loadConstitution, loadMemoryIndex } from '../brain/loader.js'
import { loadSkillsIndexWithPlugins, loadAgentsIndexWithPlugins } from '../brain/plugins.js'
import { assembleSystemPrompt, findProjectContextFiles } from '../engine/prompt.js'
import { ClientHolder } from '../engine/client-holder.js'
import type { ModelClient } from '../engine/client.js'
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages'
import { Engine, type AskUserFn } from '../engine/loop.js'
import { EngineEventBus } from '../engine/events.js'
import { ContextManager } from '../engine/context.js'
import type { ToolContext, ToolDefinition, PermissionMode, SandboxMode, RunLimits } from '../engine/types.js'
import { PermissionEngine } from './permissions.js'
import { ResourcePolicy } from './resource-policy.js'
import { HookRunner } from './hooks.js'
import { McpManager } from './mcp.js'
import { Session, SessionStore } from './sessions.js'
import { RunTraceWriter } from './traces.js'
import { AgentOrchestrator } from './agents.js'
import { projectId } from './trust.js'
import { InteractionEventAdapter, InteractionService } from '../interaction/index.js'
import type { Announcement, InteractionEventEnvelope, InteractionSnapshot } from '../interaction/index.js'
import { ExperienceStore, retrieveGuidance } from '../experience/index.js'
import { ToolRegistry } from '../tools/registry.js'
import {
  readTool,
  writeTool,
  editTool,
  applyPatchTool,
  readImageTool,
  notebookEditTool,
  diagnosticsTool,
  globTool,
  grepTool,
  bashTool,
  powershellTool,
  taskOutputTool,
  todoTool,
  statusUpdateTool,
  memoryTool,
  webfetchTool,
  websearchTool,
} from '../tools/index.js'
import { makeSkillTool } from '../tools/skill.js'
import { makeAgentTool } from '../tools/agent.js'

function gitBranch(cwd: string): string | null {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd,
      stdio: ['pipe', 'pipe', 'ignore'],
    }).toString('utf8').trim()
    return branch || null
  } catch {
    return null
  }
}

import { ensureBrainScaffold } from './bootstrap.js'

export interface HarnessSessionControllerOptions {
  paths: BrainPaths
  effectivePaths: BrainPaths
  cwd: string
  provider: ProviderId
  client: ModelClient
  settings: Settings
  projectTrust: { trusted: boolean; allowProjectHooks: boolean; allowProjectMcp: boolean }
  limits?: RunLimits
  permissionMode?: PermissionMode
  sandboxMode?: SandboxMode
  effort?: Effort
  model?: string
  outputSchemaFile?: string
  resumeId?: string
  persistSession?: boolean
  sessionStore?: SessionStore
  /**
   * Approver for `ask` permission decisions. Left undefined the engine auto-denies, which
   * is the deliberate `athena exec` contract; an interactive owner (voice, TUI) wires one.
   */
  askUser?: AskUserFn
  onAnnouncement?: (announcement: Announcement) => void
  onEnvelope?: (envelope: InteractionEventEnvelope) => void
}

export interface HarnessTurnResult {
  status: 'completed' | 'failed' | 'aborted'
  summary: string
  output?: string
  sessionId: string
  snapshot?: InteractionSnapshot
}

export class HarnessSessionController {
  public readonly session: Session
  public readonly sessionStore: SessionStore
  public readonly engine: Engine
  public readonly bus: EngineEventBus
  public readonly trace: RunTraceWriter
  public readonly interactionService: InteractionService
  public readonly gate: PermissionEngine
  public readonly hooks: HookRunner

  private sessionEnded = false
  private isRunning = false

  private constructor(
    public readonly cwd: string,
    public readonly provider: ProviderId,
    sessionStore: SessionStore,
    session: Session,
    engine: Engine,
    bus: EngineEventBus,
    trace: RunTraceWriter,
    interactionService: InteractionService,
    gate: PermissionEngine,
    hooks: HookRunner,
  ) {
    this.sessionStore = sessionStore
    this.session = session
    this.engine = engine
    this.bus = bus
    this.trace = trace
    this.interactionService = interactionService
    this.gate = gate
    this.hooks = hooks
  }

  public static async create(
    options: HarnessSessionControllerOptions,
  ): Promise<HarnessSessionController> {
    const {
      paths,
      effectivePaths,
      cwd,
      provider,
      client,
      settings,
      projectTrust,
      limits,
      permissionMode = settings.permissionMode,
      sandboxMode = settings.sandboxMode,
      effort = settings.effort,
      model = settings.model,
      outputSchemaFile,
      resumeId,
      persistSession = false,
      sessionStore,
      askUser,
      onAnnouncement,
      onEnvelope,
    } = options

    ensureBrainScaffold(paths)

    const resourcePolicy = new ResourcePolicy(cwd, sandboxMode, [paths.brainDir])
    const gate = new PermissionEngine({
      mode: permissionMode,
      allow: settings.allow,
      deny: settings.deny,
      cwd,
      sandboxMode,
      resourcePolicy,
    })

    const hooks = new HookRunner(settings.hooks)
    const bus = new EngineEventBus()

    const trace = await RunTraceWriter.create(paths.runsDir, {
      cwd,
      provider,
      model,
      mode: permissionMode,
      sandbox: sandboxMode,
    })
    trace.attach(bus)

    const interactionService = new InteractionService({
      verbosity: settings.accessibility.verbosity === 'concise'
        ? 'quiet'
        : settings.accessibility.verbosity === 'detailed'
          ? 'verbose'
          : 'balanced',
      tracePath: () => trace.file,
      onAnnouncement: (announcement) => {
        onAnnouncement?.(announcement)
      },
      onDiagnostic: (diagnostic) => trace.append('interaction-diagnostic', diagnostic),
    })

    const experienceStore = new ExperienceStore(join(paths.brainDir, 'experience'))

    const interaction = new InteractionEventAdapter({
      runId: trace.runId,
      guidanceForRepeatedFailure: ({ runId, toolName }) => {
        const objective = interactionService.snapshot(runId)?.objective.value
          ?? interactionService.snapshot(trace.runId)?.objective.value
          ?? ''
        if (!objective) return []
        return retrieveGuidance(
          experienceStore.listExperiences(),
          experienceStore.listGuidance(),
          {
            projectScope: projectId(cwd),
            objective,
            tags: [toolName.toLowerCase()],
            limit: 3,
            charBudget: 2_048,
          },
        )
      },
      onEnvelope: (event) => {
        const result = interactionService.accept(event)
        if (!result.accepted) return
        trace.recordInteraction(event)
        onEnvelope?.(event)
        if (result.announcement) {
          trace.recordAnnouncement(result.announcement, {
            coalesced: result.coalesced ?? false,
            occurrences: result.occurrences ?? 1,
          })
        }
      },
    })
    interaction.attach(bus)

    const store = sessionStore ?? new SessionStore(paths.sessionsDir, cwd)

    const registry = new ToolRegistry()
    for (const t of [
      readTool,
      writeTool,
      editTool,
      applyPatchTool,
      readImageTool,
      notebookEditTool,
      diagnosticsTool,
      globTool,
      grepTool,
      bashTool,
      powershellTool,
      taskOutputTool,
      todoTool,
      statusUpdateTool,
      memoryTool,
      webfetchTool,
      websearchTool,
    ]) {
      registry.register(t as ToolDefinition<never>)
    }
    registry.register(makeSkillTool(effectivePaths) as ToolDefinition<never>)

    const mcp = new McpManager()
    await mcp.connectAll(settings.mcpServers, registry, (m) => bus.emit({ type: 'info', message: m }))

    let outputSchema: unknown = null
    if (outputSchemaFile) {
      outputSchema = JSON.parse(await readFile(resolve(cwd, outputSchemaFile), 'utf8')) as unknown
    }

    let systemPrompt = assembleSystemPrompt({
      constitution: loadConstitution(effectivePaths),
      memoryIndex: loadMemoryIndex(effectivePaths),
      projectContext: projectTrust.trusted ? findProjectContextFiles(cwd) : [],
      toolGuidance:
        'Use Read before Write/Edit. Prefer Grep/Glob over shell find. Keep tool outputs focused.',
      skills: loadSkillsIndexWithPlugins(effectivePaths, (msg) => console.error(msg)),
      environment: {
        cwd,
        platform: process.platform,
        gitBranch: gitBranch(cwd),
        date: new Date().toISOString().slice(0, 10),
      },
    })

    if (outputSchema !== null) {
      systemPrompt +=
        '\n\nReturn the final answer as JSON only, with no Markdown fence, matching this JSON Schema:\n' +
        JSON.stringify(outputSchema)
    }

    const clientHolder = new ClientHolder(client)
    const orchestrator = new AgentOrchestrator({
      defs: loadAgentsIndexWithPlugins(effectivePaths, (msg) => console.error(msg)),
      clientFactory: () => clientHolder,
      baseRegistry: registry,
      gate,
      hooks,
      defaultModel: () => engine.getModel(),
      defaultProvider: () => engine.getProvider(),
      defaultEffort: () => engine.getEffort(),
      systemPromptBase: systemPrompt,
      runStoreDir: paths.agentRunsDir,
      traceRootDir: paths.runsDir,
      limits: limits
        ? {
            ...limits,
            maxModelCalls: Math.min(limits.maxModelCalls ?? 50, 50),
            maxToolCalls: Math.min(limits.maxToolCalls ?? 100, 100),
            maxConcurrency: Math.min(limits.maxConcurrency ?? 2, 2),
          }
        : undefined,
    })
    registry.register(makeAgentTool(orchestrator) as ToolDefinition<never>)

    let session: Session
    let history: MessageParam[] = []
    if (resumeId) {
      history = store.resume(resumeId)
      const found = store.list().find((item) => item.id === resumeId)
      if (!found) throw new Error(`No session ${resumeId}`)
      session = new Session(resumeId, found.file, history.length)
    } else if (persistSession) {
      session = store.create()
    } else {
      session = store.create()
    }

    bus.on((e) => {
      if (e.type === 'error' || e.type === 'turn-done' || e.type === 'compaction') {
        try {
          session?.appendEvent(e)
        } catch {
          /* journaling is best-effort */
        }
      }
    })

    const activeCapabilities = modelCapabilities(provider, model)
    const contextManager = new ContextManager({
      modelWindowTokens: activeCapabilities.contextWindowTokens,
    })

    const toolContext: ToolContext = {
      cwd,
      brainDir: paths.brainDir,
      projectBrainDir: effectivePaths.projectBrainDir,
      fileReadRegistry: new Set(),
      fileReadHashes: new Map(),
      todos: [],
      emit: (event) => bus.emit(event),
      abortSignal: new AbortController().signal,
      resolvePath: (path, access) => resourcePolicy.resolvePath(path, access),
      sandboxMode,
      runId: trace.runId,
    }

    const engine = new Engine({
      client: clientHolder,
      bus,
      registry,
      gate,
      hooks,
      contextManager,
      toolContext,
      provider,
      model,
      effort,
      systemPrompt,
      maxTokens: settings.maxOutputTokens ?? activeCapabilities.maxOutputTokens,
      preflightContext: true,
      ...(askUser ? { askUser } : {}),
      limits: limits ?? {
        maxModelCalls: 200,
        maxToolCalls: 1_000,
        maxTokens: 10_000_000,
        maxCostUsd: 50,
        maxDurationMs: 4 * 60 * 60_000,
        maxConcurrency: 4,
      },
      onMessagesChanged: (messages) => {
        try {
          session.rewriteOrAppend(messages)
        } catch (err) {
          bus.emit({
            type: 'error',
            message: `Session write failed: ${(err as Error).message}`,
            fatal: false,
          })
        }
      },
    })

    hooks.configure({
      invokeMcpTool: async (name, invocation, signal) => {
        const tool = registry.get(name)
        if (!tool || !name.startsWith('mcp__')) throw new Error(`Unknown MCP hook tool "${name}"`)
        const parsed = tool.schema.safeParse(invocation.payload)
        if (!parsed.success) throw new Error(`Invalid MCP hook input: ${parsed.error.message}`)
        const decision = gate.check({
          toolName: name,
          input: parsed.data,
          readOnly: tool.readOnly,
          summary: `Hook invokes ${name}`,
        })
        if (decision.decision !== 'allow') {
          throw new Error(`MCP hook tool permission denied: ${decision.reason}`)
        }
        const result = await tool.execute(parsed.data as never, {
          ...toolContext,
          abortSignal: signal,
        })
        if (result.isError) throw new Error(result.output)
        return result.output
      },
      evaluatePrompt: async (prompt, invocation, signal) => {
        const capabilities = modelCapabilities(engine.getProvider(), engine.getModel())
        return clientHolder.complete({
          model: capabilities.id,
          prompt:
            `${prompt}\n\nReturn a HookDecision JSON object only.\n\nInvocation:\n` +
            JSON.stringify(invocation),
          maxTokens: Math.min(2_048, capabilities.maxOutputTokens),
          signal,
        })
      },
      invokeAgent: async (agentName, prompt, _invocation, signal) => {
        const definition = orchestrator.getDef(agentName)
        if (!definition) throw new Error(`Unknown hook agent "${agentName}"`)
        const result = await orchestrator.runAgent(definition, prompt, {
          ...toolContext,
          abortSignal: signal,
        })
        if (result.isError) throw new Error(result.output)
        return result.output
      },
    })

    if (history.length > 0) engine.loadMessages(history)
    await hooks.run('SessionStart', { cwd })

    return new HarnessSessionController(
      cwd,
      provider,
      store,
      session,
      engine,
      bus,
      trace,
      interactionService,
      gate,
      hooks,
    )
  }

  public async submitTurn(prompt: string): Promise<HarnessTurnResult> {
    if (this.isRunning) {
      throw new Error('A harness turn is already running in this session.')
    }
    this.isRunning = true
    this.trace.recordPrompt(prompt)
    let outputText = ''
    const unsubscribe = this.bus.on((event) => {
      if (event.type === 'assistant-text') outputText += event.delta
    })

    try {
      await this.engine.runTurn(prompt)
      const runResult = this.engine.getRunResult()
      const snapshot = this.interactionService.snapshot(this.trace.runId)
      return {
        status: runResult.status === 'completed' ? 'completed' : runResult.status === 'aborted' ? 'aborted' : 'failed',
        summary: outputText.trim() || `Turn finished with status: ${runResult.status}`,
        output: outputText.trim(),
        sessionId: this.session.id,
        snapshot,
      }
    } catch (err) {
      const snapshot = this.interactionService.snapshot(this.trace.runId)
      return {
        status: 'failed',
        summary: `Harness turn failed: ${(err as Error).message}`,
        sessionId: this.session.id,
        snapshot,
      }
    } finally {
      unsubscribe()
      this.isRunning = false
    }
  }

  public abort(): void {
    this.engine.abort()
  }

  public getSnapshot(): InteractionSnapshot | undefined {
    return this.interactionService.snapshot(this.trace.runId)
  }

  /** Latest material announcement for this run, or undefined when nothing was announced. */
  public lastAnnouncement(): Announcement | undefined {
    return this.interactionService.latestAnnouncement(this.trace.runId)
  }

  public async close(reason = 'shutdown'): Promise<void> {
    if (this.sessionEnded) return
    this.sessionEnded = true
    await this.hooks.run('SessionEnd', { cwd: this.cwd, reason, run: this.engine.getRunResult() })
    await this.trace.close(this.engine.getRunResult())
  }
}
