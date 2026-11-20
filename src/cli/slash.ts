import type { MessageParam } from '@anthropic-ai/sdk/resources/messages'
import { render } from 'ink'
import React from 'react'
import type { BrainPaths } from '../brain/paths.js'
import { loadCredentials, resolveApiKey } from '../brain/credentials.js'
import type { CredentialVault } from '../brain/credential-vault.js'
import { MemoryHygieneStore } from '../brain/hygiene.js'
import {
  formatFreeTextReviewList,
  restoreFreeTextMemory,
  tombstoneFreeTextMemory,
  verifyCitations,
} from '../brain/free-text-hygiene.js'
import { loadMemoryIndex } from '../brain/loader.js'
import { generateSemanticCandidates, reviewSemanticCandidate } from '../continuity/candidates.js'
import {
  formatContinuityEpisode,
  formatContinuityRanking,
  formatContinuityRollups,
  formatContinuitySearch,
  formatContinuityStatus,
  formatSemanticCandidateReview,
} from '../continuity/presentation.js'
import type { WorkingRecallState } from '../continuity/ranking.js'
import { ContinuityStore } from '../continuity/store.js'
import {
  PROVIDERS,
  PROVIDER_IDS,
  effortLevels,
  modelKeys,
  modelLabel,
  normalizeModel,
  normalizeProvider,
  supportsEffort,
} from '../brain/models.js'
import { loadAgentsIndexWithPlugins } from '../brain/plugins.js'
import type { ClientHolder } from '../engine/client-holder.js'
import type { ContextManager } from '../engine/context.js'
import type { EngineEventBus } from '../engine/events.js'
import type { Engine } from '../engine/loop.js'
import type { TelemetryRecorder } from '../engine/telemetry.js'
import type { PermissionEngine } from '../harness/permissions.js'
import type { Session, SessionInfo, SessionStore } from '../harness/sessions.js'
import type { InteractionService } from '../interaction/index.js'
import type { LineInput } from '../presentation/index.js'
import { loadAvailableSkills } from '../tools/skill.js'
import { SessionPicker } from '../tui/components/SessionPicker.js'
import type { SlashCommand } from '../tui/slash.js'
import { makeClient } from './client.js'

/** `athena --resume` picker: renders a select list before mounting the App. Null = fresh session. */
export function pickSession(sessions: SessionInfo[]): Promise<SessionInfo | null> {
  if (sessions.length === 0) return Promise.resolve(null)
  return new Promise((resolve) => {
    const instance = render(
      React.createElement(SessionPicker, {
        sessions,
        onSelect: (s: SessionInfo) => {
          instance.unmount()
          resolve(s)
        },
        onCancel: () => {
          instance.unmount()
          resolve(null)
        },
      }),
    )
  })
}

/** Append-only equivalent of the Ink session picker. Empty input starts fresh. */
export async function pickSessionLine(
  sessions: SessionInfo[],
  input: LineInput,
  write: (line: string) => void = (line) => console.log(line),
): Promise<SessionInfo | null> {
  if (sessions.length === 0) return null
  const visible = sessions.slice(0, 20)
  write('Status: Choose a session by number, or press Enter for a fresh session.')
  visible.forEach((session, index) => {
    write(`${index + 1}. ${session.updatedAt.toISOString()} ${session.title}`)
  })
  for (;;) {
    const answer = (await input.readLine('Session: ')).trim()
    if (answer === '' || answer.toLowerCase() === 'q') return null
    const selected = visible[Number(answer) - 1]
    if (selected) return selected
    write(`Status: Enter a number from 1 to ${visible.length}, or press Enter for fresh.`)
  }
}

export type ScreenReaderCommandRoute =
  | 'shared-handler'
  | 'append-only-clear'
  | 'presentation-change'
  | 'exit'
  | 'submit-prompt'

/** Pure routing contract used by the append-only loop and parity tests. */
export function screenReaderCommandRoute(command: SlashCommand): ScreenReaderCommandRoute {
  if (command.kind === 'quit') return 'exit'
  if (command.kind === 'clear') return 'append-only-clear'
  if (command.kind === 'tui') return 'presentation-change'
  if (command.kind === 'custom') return 'submit-prompt'
  return 'shared-handler'
}

export interface ScreenReaderInterruptDependencies {
  abort(): void
  cancelInput(): boolean
  acknowledge(accepted: boolean): void
  closeInput(): void
}

/** Pure control handoff: active work cancels; idle input exits the line session. */
export function handleScreenReaderInterrupt(
  activeTurn: boolean,
  dependencies: ScreenReaderInterruptDependencies,
): 'turn-cancelled' | 'session-exit' {
  if (activeTurn) {
    dependencies.abort()
    dependencies.cancelInput()
    dependencies.acknowledge(true)
    return 'turn-cancelled'
  }
  dependencies.closeInput()
  return 'session-exit'
}

function currentWorkingRecallState(
  messages: MessageParam[],
  sessionId: string | null,
  projectId: string,
): WorkingRecallState[] {
  const content = messages.map((message) => {
    if (typeof message.content === 'string') return message.content
    return message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join(' ')
  }).filter(Boolean).join('\n').slice(-32_000).trim()
  if (!content) return []
  return [{
    id: `working:${sessionId ?? 'current'}`,
    projectId,
    observedAt: new Date().toISOString(),
    content,
    sourceIds: sessionId ? [`session:${sessionId}`] : [],
  }]
}

export interface SlashDeps {
  bus: EngineEventBus
  engine: Engine
  gate: PermissionEngine
  contextManager: ContextManager
  client: ClientHolder
  store: SessionStore
  session: Session | null
  paths: BrainPaths
  credentialVault: CredentialVault
  interactionService?: InteractionService
  runId?: string
  permissionDetails?: (id: string) => string | null
  commands?: ReadonlyMap<string, { description: string; argumentHint: string | null }>
  vmpRecorder?: TelemetryRecorder
  continuityStore?: ContinuityStore
  timeZone?: string
}

export function makeSlashHandler(deps: SlashDeps): (cmd: SlashCommand) => void {
  const {
    bus,
    engine,
    gate,
    contextManager,
    client,
    store,
    session,
    paths,
    credentialVault,
    interactionService,
    runId,
    permissionDetails,
    commands,
    vmpRecorder,
    continuityStore,
    timeZone,
  } = deps
  const info = (message: string) => bus.emit({ type: 'info', message })
  return (cmd) => {
    switch (cmd.kind) {
      case 'help': {
        const customList =
          commands && commands.size > 0
            ? '\nCustom: ' +
              [...commands.entries()]
                .map(([name, c]) => `/${name}${c.argumentHint ? ` ${c.argumentHint}` : ''} - ${c.description}`)
                .join(', ')
            : ''
        info(
          `Commands: /help /status /repeat /details /verbosity <concise|balanced|detailed> /clear /resume /compact /model <${modelKeys(engine.getProvider()).join('|')}> /effort <${effortLevels(engine.getProvider(), engine.getModel()).join('|') || 'unavailable'}> /provider <${PROVIDER_IDS.join('|')}> /mode <normal|acceptEdits|plan|trusted> /tui <fullscreen|classic> /memory /skills /agents /quit\n` +
            '/clear clears the screen (transcript display only) — conversation context is unchanged; use /compact to shrink it.\n' +
            '/tui fullscreen switches to an alternate-screen buffer with a pinned input (like vim/htop); /tui classic returns to normal scrollback.\n' +
            '/model /provider /effort /mode /tui run with no argument open a picker to choose a value instead of requiring you to type one.' +
            customList,
        )
        break
      }
      case 'status':
        info(
          interactionService && runId
            ? interactionService.status(runId)
            : 'Status: semantic state is unavailable.',
        )
        break
      case 'repeat':
        info(
          interactionService && runId
            ? interactionService.repeat(runId)
            : 'No material announcement is available. Use /status.',
        )
        break
      case 'details': {
        const permissionMatch = /^permission\s+(.+)$/.exec(cmd.value)
        const permission = permissionMatch ? permissionDetails?.(permissionMatch[1]!) : null
        info(
          permission ??
            (interactionService && runId
              ? interactionService.details(runId)
              : 'No material detail is available. Use /status.'),
        )
        break
      }
      case 'verbosity': {
        const verbosity = cmd.value === 'concise' ? 'quiet' : cmd.value === 'detailed' ? 'verbose' : 'balanced'
        interactionService?.setVerbosity(verbosity)
        info(`Status: Announcement verbosity is ${cmd.value} for this session.`)
        break
      }
      case 'mode':
        gate.setMode(cmd.value)
        bus.emit({ type: 'status', patch: { mode: cmd.value } })
        info(`Permission mode: ${cmd.value}`)
        break
      case 'model': {
        const provider = engine.getProvider()
        const key = normalizeModel(provider, cmd.value)
        if (!key) {
          info(`Unknown model: ${cmd.value} (valid for ${provider}: ${modelKeys(provider).join(', ')})`)
          break
        }
        engine.setModel(key)
        bus.emit({ type: 'status', patch: { model: modelLabel(provider, key), modelKey: key, effort: engine.getEffort() } })
        info(
          supportsEffort(provider, key)
            ? `Model: ${modelLabel(provider, key)} (effort ${engine.getEffort()})`
            : `Model: ${modelLabel(provider, key)} - effort/extended thinking not applicable on this model.`,
        )
        break
      }
      case 'provider': {
        const p = normalizeProvider(cmd.value)
        if (!p) {
          info(`Unknown provider: ${cmd.value}, choose ${PROVIDER_IDS.join(' or ')}.`)
          break
        }
        if (p === engine.getProvider()) {
          info(`Already on ${PROVIDERS[p].label}.`)
          break
        }
        let resolved
        // Every resolveApiKey call site must pass a warning sink: a vault read that
        // fails (the cross-machine DPAPI blob case) resolves as "no key" plus a warning
        // instead of throwing, so without a sink the specific, actionable message is
        // swallowed and the user is told the key is simply "not configured".
        // Boot-time sites warn on stderr; inside a mounted TUI stderr is unreadable, so
        // the sink is the same transcript channel every other slash message uses.
        let vaultWarned = false
        const warnCredentials = (message: string): void => {
          vaultWarned = true
          info(message)
        }
        try {
          resolved = resolveApiKey(p, loadCredentials(paths), process.env, credentialVault, warnCredentials)
        } catch (err) {
          info((err as Error).message)
          break
        }
        if (!resolved && vaultWarned) {
          // The warning already named the cause and the fix (`athena auth`); adding the
          // generic "not configured" line on top of it would contradict it.
          break
        }
        if (!resolved) {
          info(
            `No API key configured for ${PROVIDERS[p].label}. Run \`athena auth\` (or restart with \`athena --provider ${p}\`) to add one.`,
          )
          break
        }
        client.swap(makeClient(p, resolved.key, vmpRecorder))
        engine.setProvider(p)
        engine.setModel(PROVIDERS[p].defaultModel)
        bus.emit({
          type: 'status',
          patch: {
            model: modelLabel(p, PROVIDERS[p].defaultModel),
            modelKey: PROVIDERS[p].defaultModel,
            provider: p,
            effort: engine.getEffort(),
          },
        })
        info(
          `Provider: ${PROVIDERS[p].label}, model ${modelLabel(p, PROVIDERS[p].defaultModel)} (session-only; \`athena auth\` changes the default).`,
        )
        break
      }
      case 'effort': {
        try {
          engine.setEffort(cmd.value)
        } catch (error) {
          info((error as Error).message)
          break
        }
        bus.emit({ type: 'status', patch: { effort: cmd.value } })
        const provider = engine.getProvider()
        const key = engine.getModel()
        info(
          supportsEffort(provider, key)
            ? `Effort: ${cmd.value}`
            : `Effort set to ${cmd.value} - ${modelLabel(provider, key)} ignores it.`,
        )
        break
      }
      case 'compact':
        void (async () => {
          try {
            const { messages, summary } = await contextManager.compact(engine.getMessages(), (p) =>
              client.complete({ model: engine.getModelId(), prompt: p, maxTokens: 2048 }),
            )
            if (summary === '') {
              info('Nothing to compact yet.')
              return
            }
            engine.loadMessages(messages)
            session?.rewriteOrAppend(messages)
            bus.emit({ type: 'compaction', summary })
          } catch (err) {
            bus.emit({
              type: 'error',
              message: `Compaction failed: ${(err as Error).message}`,
              fatal: false,
            })
          }
        })()
        break
      case 'memory': {
        if (!cmd.action) {
          info(loadMemoryIndex(paths) ?? '(no memory index)')
          break
        }
        const memoryStore = continuityStore ?? new ContinuityStore(paths.continuityDir, { onWarn: info })
        if (cmd.action === 'status') {
          info(formatContinuityStatus(memoryStore))
        } else if (cmd.action === 'hygiene') {
          const result = verifyCitations(paths.memoryDir, process.cwd())
          info(
            `Checked ${result.checked} memory file(s); relocated ${result.relocated} citation(s); flagged ${result.flagged.length}.\n` +
              formatFreeTextReviewList(paths.memoryDir),
          )
        } else if (cmd.action === 'rebuild') {
          const result = memoryStore.rebuild(paths.sessionsDir)
          info(`Indexed ${result.episodeCount} episode(s) from ${result.sessionCount} session(s).`)
        } else if (cmd.action === 'candidates') {
          try {
            const semanticStore = new MemoryHygieneStore(paths.memoryDir, { onWarn: info })
            const result = generateSemanticCandidates(memoryStore, paths.sessionsDir, semanticStore)
            info(formatSemanticCandidateReview(result, semanticStore.listAll()))
          } catch (error) {
            info(`Could not generate semantic candidates: ${(error as Error).message}`)
          }
        } else if (cmd.action === 'review') {
          const parts = (cmd.value ?? '').split(/\s+/).filter(Boolean)
          if (parts[0] === '--list') {
            info(formatFreeTextReviewList(paths.memoryDir))
            break
          }
          if (parts[0] === '--keep' && parts[1]) {
            try {
              restoreFreeTextMemory(paths.memoryDir, parts[1])
              info(`Restored free-text memory ${parts[1]} to active.`)
            } catch (error) {
              info(`Could not restore memory: ${(error as Error).message}`)
            }
            break
          }
          if (parts[0] === '--tombstone' && parts[1]) {
            try {
              tombstoneFreeTextMemory(paths.memoryDir, parts[1], parts.slice(2).join(' ') || 'tombstoned via review')
              info(`Tombstoned free-text memory ${parts[1]}.`)
            } catch (error) {
              info(`Could not tombstone memory: ${(error as Error).message}`)
            }
            break
          }
          const [memoryId, action] = parts
          if (!memoryId || (action !== 'promote' && action !== 'reject')) {
            info('Usage: /memory review <memory-id> <promote|reject> | --list | --keep <path> | --tombstone <path> [reason]')
            break
          }
          try {
            const semanticStore = new MemoryHygieneStore(paths.memoryDir, { onWarn: info })
            const reviewed = reviewSemanticCandidate(semanticStore, memoryStore, paths.sessionsDir, memoryId, action)
            info(`Semantic memory ${reviewed.memoryId} ${action === 'promote' ? 'promoted' : 'rejected'}.`)
          } catch (error) {
            info(`Could not review semantic memory: ${(error as Error).message}`)
          }
        } else if (cmd.action === 'forget') {
          const memoryId = cmd.value ?? ''
          try {
            const semanticStore = new MemoryHygieneStore(paths.memoryDir, { onWarn: info })
            const forgotten = semanticStore.forget(memoryId)
            info(`Semantic memory ${forgotten.memoryId} forgotten. Its source session remains available for historical recall.`)
          } catch (error) {
            info(`Could not forget semantic memory: ${(error as Error).message}`)
          }
        } else if (cmd.action === 'rank') {
          const semanticStore = new MemoryHygieneStore(paths.memoryDir, { onWarn: info })
          info(formatContinuityRanking(memoryStore, {
            sessionsRoot: paths.sessionsDir,
            query: cmd.value ?? '',
            semanticMemories: semanticStore.listAll(),
            working: currentWorkingRecallState(engine.getMessages(), session?.id ?? null, store.projectId),
            currentProjectId: store.projectId,
            ...(cmd.projectId ? { projectId: cmd.projectId } : {}),
            ...(timeZone ? { timeZone } : {}),
          }))
        } else if (cmd.action === 'rollup') {
          info(formatContinuityRollups(
            memoryStore,
            paths.sessionsDir,
            timeZone,
            cmd.value as 'day' | 'week' | 'month' | 'quarter' | 'year' | undefined,
          ))
        } else if (cmd.action === 'search' || cmd.action === 'timeline') {
          info(formatContinuitySearch(memoryStore, paths.sessionsDir, {
            action: cmd.action,
            query: cmd.value ?? '',
            ...(cmd.projectId ? { projectId: cmd.projectId } : {}),
            ...(timeZone ? { timeZone } : {}),
          }))
        } else {
          info(formatContinuityEpisode(memoryStore, paths.sessionsDir, cmd.value ?? ''))
        }
        break
      }
      case 'skills': {
        const skills = loadAvailableSkills(paths)
        info(
          skills.length > 0
            ? skills.map((s) => `${s.name} — ${s.description}`).join('\n')
            : '(no skills defined)',
        )
        break
      }
      case 'agents': {
        const agents = loadAgentsIndexWithPlugins(paths)
        info(
          agents.length > 0
            ? agents.map((a) => `${a.name} — ${a.description}`).join('\n')
            : '(no agents defined)',
        )
        break
      }
      case 'resume': {
        const sessions = store.list().slice(0, 10)
        info(
          sessions.length > 0
            ? 'Recent sessions (restart with --resume to pick one):\n' +
                sessions
                  .map((s) => `${s.updatedAt.toISOString().slice(0, 16).replace('T', ' ')} ${s.title}`)
                  .join('\n')
            : '(no sessions for this project yet)',
        )
        break
      }
      case 'error':
        info(cmd.value)
        break
      default:
        // 'clear', 'quit', and 'tui' are handled inside the App component.
        break
    }
  }
}
