// src/harness/controller.ts — Shared Athena Harness Session Controller for the interactive
// TUI, the append-only screen-reader loop, CLI exec, and voice.
import { execSync } from 'node:child_process'
import { join } from 'node:path'
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
import { ProtectedPaths } from './protected-paths.js'
import { ResourcePolicy } from './resource-policy.js'
import { HookRunner } from './hooks.js'
import { McpManager } from './mcp.js'
import {
  latestUserMessageSourceRef,
  sessionLastLineNumber,
  Session,
  SessionStore,
} from './sessions.js'
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
import { ContinuityStore } from '../continuity/store.js'
import { prepareAnswerTimeRecall } from '../continuity/answer-recall.js'
import { createJevRecallRouter, JEV_MODEL, type RecallIntentRouter, type RecallRouteDecision } from '../decision/jev.js'
import { JevSpeechActEventSchema, JEV_SPEECH_ACT_PERSISTENCE_CONFIDENCE } from '../continuity/schemas.js'

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

/** A session the caller picked itself: the `--continue` latest pick and the `--resume` picker. */
export interface SelectedSession {
  id: string
  file: string
  messages: MessageParam[]
}

export interface HarnessSessionControllerOptions {
  /** Unfiltered paths, for the harness's own storage: traces, sessions, agent runs, experience. */
  paths: BrainPaths
  /**
   * The same paths with `projectBrainDir` nulled out when the project is untrusted. Everything
   * that loads author-supplied content reads these: constitution, memory index, skills, agents,
   * and the tool context's project brain dir.
   */
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
  /**
   * Already-parsed output schema appended to the system prompt. The caller reads the file
   * and owns the exit code for a malformed one, so a bad schema fails before anything is
   * built rather than after MCP servers are spawned.
   */
  outputSchema?: unknown
  resumeId?: string
  /**
   * Whether the session is written to disk. False mints a session for identity only and
   * journals nothing, which is `athena exec` without `--persist-session`. A resumed
   * session is always written back regardless.
   */
  persistSession?: boolean
  sessionStore?: SessionStore
  /**
   * Session selection richer than `resumeId`: the `--continue` latest-session pick and the
   * interactive `--resume` picker. Runs at the same point in startup the `resumeId` branch
   * does, so a picker still mounts after the plugin warnings have printed rather than
   * racing them onto the same frame. Returning null starts a fresh session.
   */
  selectSession?: (store: SessionStore) => Promise<SelectedSession | null>
  /**
   * Approver for `ask` permission decisions. Left undefined the engine auto-denies, which
   * is the deliberate `athena exec` contract; an interactive owner (voice, TUI) wires one.
   */
  askUser?: AskUserFn
  /** Injectable decision router for deterministic harness integrations. */
  recallRouter?: RecallIntentRouter
  onAnnouncement?: (announcement: Announcement) => void
  onEnvelope?: (envelope: InteractionEventEnvelope) => void
}

/** Everything the private constructor takes; assembled once by `create`. */
interface HarnessSessionControllerParts {
  cwd: string
  provider: ProviderId
  sessionStore: SessionStore
  session: Session
  sessionPersisted: boolean
  initialMessages: MessageParam[]
  engine: Engine
  bus: EngineEventBus
  trace: RunTraceWriter
  interaction: InteractionEventAdapter
  interactionService: InteractionService
  experienceStore: ExperienceStore
  mcp: McpManager
  orchestrator: AgentOrchestrator
  contextManager: ContextManager
  client: ClientHolder
  gate: PermissionEngine
  hooks: HookRunner
  continuityStore: ContinuityStore
}

export interface HarnessTurnResult {
  status: 'completed' | 'failed' | 'aborted'
  summary: string
  output?: string
  sessionId: string
  snapshot?: InteractionSnapshot
}

export class HarnessSessionController {
  public readonly cwd: string
  public readonly provider: ProviderId
  public readonly session: Session
  /** False when the caller opted out of persistence: the session is minted but never written. */
  public readonly sessionPersisted: boolean
  public readonly sessionStore: SessionStore
  /** Reconstructed history the engine was loaded with, for a presentation that replays it. */
  public readonly initialMessages: MessageParam[]
  public readonly engine: Engine
  public readonly bus: EngineEventBus
  public readonly trace: RunTraceWriter
  /** Semantic event adapter, for callers that record objectives or detach at teardown. */
  public readonly interaction: InteractionEventAdapter
  public readonly interactionService: InteractionService
  public readonly experienceStore: ExperienceStore
  public readonly mcp: McpManager
  public readonly orchestrator: AgentOrchestrator
  public readonly contextManager: ContextManager
  public readonly client: ClientHolder
  public readonly gate: PermissionEngine
  public readonly hooks: HookRunner
  public readonly continuityStore: ContinuityStore

  private sessionEnded = false
  private isRunning = false

  private constructor(parts: HarnessSessionControllerParts) {
    this.cwd = parts.cwd
    this.provider = parts.provider
    this.sessionStore = parts.sessionStore
    this.session = parts.session
    this.sessionPersisted = parts.sessionPersisted
    this.initialMessages = parts.initialMessages
    this.engine = parts.engine
    this.bus = parts.bus
    this.trace = parts.trace
    this.interaction = parts.interaction
    this.interactionService = parts.interactionService
    this.experienceStore = parts.experienceStore
    this.mcp = parts.mcp
    this.orchestrator = parts.orchestrator
    this.contextManager = parts.contextManager
    this.client = parts.client
    this.gate = parts.gate
    this.hooks = parts.hooks
    this.continuityStore = parts.continuityStore
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
      outputSchema = null,
      resumeId,
      persistSession = true,
      sessionStore,
      selectSession,
      askUser,
      onAnnouncement,
      onEnvelope,
    } = options

    ensureBrainScaffold(paths)

    const protectedPaths = ProtectedPaths.from(settings.protectedPaths)
    const resourcePolicy = new ResourcePolicy(cwd, sandboxMode, [paths.brainDir], protectedPaths)
    const gate = new PermissionEngine({
      mode: permissionMode,
      allow: settings.allow,
      deny: settings.deny,
      cwd,
      sandboxMode,
      resourcePolicy,
      protectedPaths,
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
    // The linked local catalog is optional and is not read into provider prompts here.
    const continuityStore = new ContinuityStore(paths.continuityDir, {
      onWarn: (warning) => console.error(warning),
    })
    const recallRouter = options.recallRouter ?? createJevRecallRouter({
      enabled: settings.jev.enabled,
      apiKey: process.env.TYPESAFE_API_KEY,
      telemetry: (event) => trace.append('decision-model-call', event),
    })
    const answerTimeRecall = ({ request, decision }: {
      request: string
      decision?: RecallRouteDecision
    }) => prepareAnswerTimeRecall({
      query: request,
      ...(decision ? { decision } : {}),
      sessionsRoot: paths.sessionsDir,
      store: continuityStore,
      memoryDir: paths.memoryDir,
      continuityRoot: paths.continuityDir,
      currentProjectId: store.projectId,
      ...(settings.timeZone ? { configuredTimeZone: settings.timeZone } : {}),
    })

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

    // MCP: connect to configured servers and mount their tools into the BASE registry
    // BEFORE the orchestrator is built, so sub-agents inherit them under restriction.
    // Connection failures are non-fatal (handled inside connectAll); an empty config is a no-op.
    const mcp = new McpManager()
    await mcp.connectAll(settings.mcpServers, registry, (m) => bus.emit({ type: 'info', message: m }))

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
      protectedPaths,
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

    // Session selection: an explicit id wins, then the caller's own picker, then fresh.
    let session: Session
    let history: MessageParam[] = []
    let resumed = false
    if (resumeId) {
      history = store.resume(resumeId)
      const found = store.list().find((item) => item.id === resumeId)
      if (!found) throw new Error(`No session ${resumeId}`)
      session = new Session(resumeId, found.file, history.length)
      resumed = true
    } else {
      const selected = selectSession ? await selectSession(store) : null
      if (selected) {
        history = selected.messages
        session = new Session(selected.id, selected.file, history.length)
        resumed = true
      } else {
        session = store.create()
      }
    }
    // Reconstructed history is always written back; a fresh one only when asked.
    const sessionPersisted = persistSession || resumed
    const journal = sessionPersisted ? session : null

    // Event journal: errors, turn completions (with usage), and compactions land in the
    // session file so a crash is diagnosable from disk. A failed journal write must never
    // crash or recurse — swallow it here, no bus emit from inside the subscriber.
    bus.on((e) => {
      if (e.type === 'error' || e.type === 'turn-done' || e.type === 'compaction') {
        try {
          journal?.appendEvent(e)
        } catch {
          /* journaling is best-effort */
        }
      }
    })
    bus.on((event) => {
      if (event.type !== 'turn-done' || !journal) return
      try {
        const result = continuityStore.indexSession(paths.sessionsDir, store.projectId, session.id)
        if (result.state === 'corrupt') {
          console.error('Continuity local index was corrupt; this turn remains in its source session. Run `athena memory rebuild`.')
        }
      } catch {
        console.error('Continuity local index could not update this session; normal conversation completed. Run `athena memory rebuild`.')
      }
    })

    const activeCapabilities = modelCapabilities(provider, model)
    const contextManager = new ContextManager({
      modelWindowTokens: activeCapabilities.contextWindowTokens,
    })

    let currentUserTurn: { prompt: string; afterLineNumber: number } | null = null
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
      ...(journal
        ? {
            setCurrentUserTurnPrompt: (prompt) => {
              currentUserTurn = { prompt, afterLineNumber: sessionLastLineNumber(session.file) }
            },
            getCurrentUserSourceRef: () =>
              currentUserTurn
                ? latestUserMessageSourceRef(session.file, store.projectId, session.id, currentUserTurn)
                : null,
            recordCurrentUserSpeechAct: ({ speechAct, confidence }) => {
              if (confidence < JEV_SPEECH_ACT_PERSISTENCE_CONFIDENCE) return
              const sourceRef = currentUserTurn
                ? latestUserMessageSourceRef(session.file, store.projectId, session.id, currentUserTurn)
                : null
              if (!sourceRef) return
              const event = JevSpeechActEventSchema.parse({
                type: 'jev-speech-act-classification',
                schemaVersion: 1,
                model: JEV_MODEL,
                sourceRef,
                speechAct,
                confidence,
              })
              try {
                journal.appendEvent(event)
              } catch {
                console.error(`Jev speech-act label could not be saved to session ${session.id}; this turn will continue normally.`)
              }
            },
          }
        : {}),
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
      recallRouter,
      answerTimeRecall,
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
        // A full disk / locked file must not kill the presentation mid-turn.
        try {
          journal?.rewriteOrAppend(messages)
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

    return new HarnessSessionController({
      cwd,
      provider,
      sessionStore: store,
      session,
      sessionPersisted,
      initialMessages: history,
      engine,
      bus,
      trace,
      interaction,
      interactionService,
      experienceStore,
      mcp,
      orchestrator,
      contextManager,
      client: clientHolder,
      gate,
      hooks,
      continuityStore,
    })
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

  /**
   * Run the SessionEnd hook, once. Split out from `close` for callers that close the trace
   * themselves, after work that has to land between the two (MCP teardown, the exec exit
   * code) — the ordering of those side effects is part of their contract.
   */
  public async endSession(reason = 'shutdown'): Promise<void> {
    if (this.sessionEnded) return
    this.sessionEnded = true
    await this.hooks.run('SessionEnd', { cwd: this.cwd, reason, run: this.engine.getRunResult() })
  }

  public async close(reason = 'shutdown'): Promise<void> {
    if (this.sessionEnded) return
    await this.endSession(reason)
    await this.trace.close(this.engine.getRunResult())
  }
}
