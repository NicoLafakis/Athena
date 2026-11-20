// src/cli.ts — composition root: brain + engine + harness + TUI.
import { appendFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages'
import { render } from 'ink'
import React from 'react'
import { runAuthWizard, terminalIO } from './auth/wizard.js'
import {
  loadCredentials,
  migrateCredentialsToVault,
  resolveApiKey,
  type Credentials,
} from './brain/credentials.js'
import { createCredentialVault } from './brain/credential-vault.js'
import {
  PROVIDERS,
  PROVIDER_IDS,
  defaultEffort,
  modelKeys,
  modelLabel,
  normalizeModel,
  resolveModelRequest,
  type ProviderId,
} from './brain/models.js'
import { resolveBrainPaths } from './brain/paths.js'
import { loadCommandsIndexWithPlugins } from './brain/plugins.js'
import { loadSettings } from './brain/settings.js'
import { FileLedgerStore } from './brain/vmp-ledger.js'
import { validateJsonOutput } from './engine/output-schema.js'
import { makeTelemetryRecorder } from './engine/telemetry.js'
import type { RunResult } from './engine/types.js'
import { ensureBrainScaffold } from './harness/bootstrap.js'
import { HarnessSessionController } from './harness/controller.js'
import { collectDiagnostics, formatDiagnostics } from './harness/diagnostics.js'
import { gitBranch } from './harness/git.js'
import type { SessionStore } from './harness/sessions.js'
import type { InteractionEventEnvelope } from './interaction/index.js'
import { createInteractionSnapshot } from './interaction/state.js'
import {
  ReadlineLineInput,
  ScreenReaderPresentation,
  createAccessiblePermissionRequest,
  formatPermissionDiffDetail,
  permissionDiff,
  permissionDiffStats,
} from './presentation/index.js'
import { App, PermissionBridge } from './tui/App.js'
import { parseSlash } from './tui/slash.js'
import { getVersion } from './version.js'
import {
  CLI_EXIT,
  EXEC_USAGE,
  HELP_TEXT,
  parseArgs,
  resolveAuthPresentation,
  type AccessibilityPresentation,
  type CliCommand,
  type ExecOptions,
  type ExecOutputMode,
  type VoiceModel,
} from './cli/args.js'
import { makeClient } from './cli/client.js'
import {
  runAuthCommand,
  runImportCommand,
  runJournalCliCommand,
  runLearnCommand,
  runPluginCommand,
  runSessionCommand,
  runTrustCommand,
  runVmpCommand,
  runWatchCommand,
} from './cli/commands.js'
import {
  handleScreenReaderInterrupt,
  makeSlashHandler,
  pickSession,
  pickSessionLine,
  screenReaderCommandRoute,
  type ScreenReaderCommandRoute,
  type ScreenReaderInterruptDependencies,
  type SlashDeps,
} from './cli/slash.js'
import {
  emitStalenessWarnings,
  loadSessionSettings,
  resolveSessionTrust,
} from './cli/session-bootstrap.js'
import { doctorPosture } from './cli/trust.js'
import { runVoiceCommand } from './cli/voice.js'

export {
  CLI_EXIT,
  handleScreenReaderInterrupt,
  makeSlashHandler,
  parseArgs,
  pickSessionLine,
  resolveAuthPresentation,
  screenReaderCommandRoute,
  type AccessibilityPresentation,
  type CliCommand,
  type ExecOptions,
  type ExecOutputMode,
  type ScreenReaderCommandRoute,
  type ScreenReaderInterruptDependencies,
  type SlashDeps,
  type VoiceModel,
}

function finalAssistantText(messages: MessageParam[]): string {
  const message = [...messages].reverse().find((item) => item.role === 'assistant')
  if (!message) return ''
  if (typeof message.content === 'string') return message.content
  return message.content
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

async function readStdin(): Promise<string> {
  let value = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) value += chunk
  return value
}

async function main(): Promise<void> {
  const cwd = process.cwd()
  const paths = resolveBrainPaths({ cwd })
  const cmd = parseArgs(process.argv.slice(2))

  if (cmd.command === 'error') {
    console.error(cmd.message)
    process.exitCode = CLI_EXIT.usage
    return
  }
  if (cmd.command === 'help') {
    console.log(HELP_TEXT)
    return
  }
  if (cmd.command === 'exec-help') {
    console.log(EXEC_USAGE)
    return
  }
  if (cmd.command === 'version') {
    console.log(getVersion())
    return
  }
  if (cmd.command === 'doctor') {
    const report = collectDiagnostics(paths, cwd, getVersion(), { posture: doctorPosture(paths, cwd) })
    console.log(cmd.json ? JSON.stringify(report, null, 2) : formatDiagnostics(report))
    process.exitCode = report.checks.some((check) => check.status === 'error') ? 1 : 0
    return
  }
  if (cmd.command === 'import') {
    await runImportCommand(cmd, paths)
    return
  }
  if (cmd.command === 'trust') {
    runTrustCommand(cmd, paths, cwd)
    return
  }
  if (cmd.command === 'journal') {
    await runJournalCliCommand(cmd, paths, cwd)
    return
  }
  ensureBrainScaffold(paths)
  if (cmd.command === 'vmp') {
    await runVmpCommand(cmd, paths)
    return
  }
  if (cmd.command === 'plugin') {
    runPluginCommand(cmd, paths)
    return
  }
  if (cmd.command === 'learn') {
    await runLearnCommand(cmd, paths, cwd)
    return
  }
  if (cmd.command === 'session') {
    runSessionCommand(cmd, paths, cwd)
    return
  }
  const credentialVault = createCredentialVault(paths)
  if (cmd.command === 'voice') {
    await runVoiceCommand(cmd, paths, cwd, credentialVault)
    return
  }
  if (cmd.command === 'watch') {
    await runWatchCommand(cmd, paths, cwd)
    return
  }
  if (cmd.command === 'auth') {
    await runAuthCommand(cmd, paths, credentialVault)
    return
  }

  const isExec = cmd.command === 'exec'
  const explicitlyLineOriented =
    !isExec && 'accessibility' in cmd && cmd.accessibility === 'screen-reader'
  // Interactive commands need a real terminal; `exec` is the intentional
  // non-TTY surface. Explicit screen-reader mode is also line-oriented and can
  // safely consume redirected lines without mounting Ink.
  if (!isExec && !explicitlyLineOriented && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    console.log(HELP_TEXT)
    console.log('\n(interactive session skipped: not a TTY)')
    return
  }
  // Environment staleness, on stderr before Ink mounts (alt-screen entry happens later in a
  // useEffect, so pre-render stderr is genuinely visible). Filesystem checks only — no git,
  // no subprocess, nothing that can throw — and silent when everything is fresh.
  emitStalenessWarnings((warning) => console.error(warning))
  const { projectTrust, effectivePaths } = await resolveSessionTrust(paths, cwd, !isExec)
  // One line per distinct credential-path problem, on stderr, before the TUI mounts.
  // Deduped because key resolution runs several times below.
  const seenCredentialWarnings = new Set<string>()
  const warnCredentials = (message: string): void => {
    if (seenCredentialWarnings.has(message)) return
    seenCredentialWarnings.add(message)
    console.error(message)
  }
  let credentials: Credentials
  try {
    // Vault migration is best effort by construction (it cannot throw), so this catch
    // only ever sees genuine credentials-file errors: malformed JSON, I/O, permissions.
    credentials = migrateCredentialsToVault(paths, loadCredentials(paths), credentialVault, {
      onWarn: warnCredentials,
    })
  } catch (err) {
    console.error((err as Error).message)
    process.exitCode = 1
    return
  }
  let provider: ProviderId = cmd.provider ?? credentials.activeProvider
  const authPresentation = isExec
    ? 'standard'
    : resolveAuthPresentation(cmd, loadSettings(paths, provider).accessibility.presentation)
  let resolved = resolveApiKey(provider, credentials, process.env, credentialVault, warnCredentials)
  if (!resolved && cmd.provider === undefined) {
    // The default provider has no key but another one does (e.g. no credentials file
    // and only MOONSHOT_API_KEY set, while activeProvider defaults to openai):
    // adopt the keyed provider for the session instead of forcing the wizard.
    const withKey = PROVIDER_IDS.find((p) =>
      resolveApiKey(p, credentials, process.env, credentialVault, warnCredentials),
    )
    if (withKey) {
      provider = withKey
      resolved = resolveApiKey(provider, credentials, process.env, credentialVault, warnCredentials)!
      // stderr, never stdout: `athena exec --output json` must emit pure envelopes.
      console.error(`Using ${PROVIDERS[provider].label} (only provider with a configured key).`)
    }
  }
  if (!resolved) {
    if (isExec) {
      console.error(`No API key found for ${PROVIDERS[provider].label}; run \`athena auth\`.`)
      process.exitCode = CLI_EXIT.provider
      return
    }
    if (
      cmd.provider === undefined &&
      PROVIDER_IDS.every(
        (p) => !resolveApiKey(p, credentials, process.env, credentialVault, warnCredentials),
      )
    ) {
      // True cold start: no --provider flag and no key anywhere. Run the FULL wizard
      // (provider pick included) and adopt whatever the user chose.
      console.log(`No API key configured yet. Let's set one up.`)
      const done = await runAuthWizard({
        paths,
        vault: credentialVault,
        io: terminalIO({ screenReader: authPresentation === 'screen-reader' }),
      })
      provider = done.provider
      resolved = { key: done.key, source: 'file' }
    } else {
      // A specific provider is implied (--provider flag, or another provider already
      // has a key): drop into the wizard scoped to it, then continue into the session.
      console.log(
        `No API key found for ${PROVIDERS[provider].label} - let's set one up. (This provider becomes your default; athena auth switches it.)`,
      )
      const done = await runAuthWizard({
        paths,
        provider,
        vault: credentialVault,
        io: terminalIO({ screenReader: authPresentation === 'screen-reader' }),
      })
      resolved = { key: done.key, source: 'file' }
    }
  }
  // Settings warnings (e.g. a model that is invalid for the active provider falling
  // back to the provider default) surface on stderr before the TUI mounts.
  // Trusted-project bootstrap: effective trusted mode (+ unrestricted shell on win32).
  // exec keeps its explicit flag-driven defaults instead (headless contract).
  const { settings } = loadSessionSettings({
    paths,
    effectivePaths,
    cwd,
    provider,
    projectTrust,
    applyTrust: !isExec,
    warn: (msg) => console.error(msg),
  })
  const vmpLedger = settings.vmp.enabled ? FileLedgerStore.forPaths(paths) : undefined
  const vmpRecorder = makeTelemetryRecorder(vmpLedger)
  if (isExec) {
    settings.permissionMode = cmd.options.permissionMode
    settings.sandboxMode = cmd.options.sandboxMode
    settings.effort = cmd.options.effort ?? defaultEffort(provider)
    if (cmd.options.model) {
      const selected = normalizeModel(provider, cmd.options.model)
      if (!selected) {
        console.error(
          `Unknown model '${cmd.options.model}' for ${provider}: ${modelKeys(provider).join(', ')}`,
        )
        process.exitCode = CLI_EXIT.usage
        return
      }
      settings.model = selected
    }
    try {
      resolveModelRequest(provider, settings.model, settings.effort)
    } catch (error) {
      console.error((error as Error).message)
      process.exitCode = CLI_EXIT.usage
      return
    }
  }
  const presentationMode: AccessibilityPresentation =
    !isExec && 'accessibility' in cmd
      ? (cmd.accessibility ?? settings.accessibility.presentation)
      : settings.accessibility.presentation
  const screenInput =
    presentationMode === 'screen-reader' && !isExec ? new ReadlineLineInput() : null
  const screenPresentation = screenInput
    ? new ScreenReaderPresentation({
        input: screenInput,
        write: (chunk) => process.stdout.write(chunk),
      })
    : null
  let execPrompt: string | null = null
  let outputSchema: unknown = null
  if (isExec) {
    execPrompt = cmd.options.prompt
    if (execPrompt === null) {
      if (process.stdin.isTTY) {
        console.error(`${EXEC_USAGE}\nProvide a prompt argument or pipe one over stdin.`)
        process.exitCode = CLI_EXIT.usage
        return
      }
      execPrompt = (await readStdin()).trim()
    }
    if (execPrompt === '') {
      console.error('athena exec received an empty prompt')
      process.exitCode = CLI_EXIT.usage
      return
    }
    if (cmd.options.outputSchemaFile) {
      try {
        outputSchema = JSON.parse(
          await readFile(resolve(cwd, cmd.options.outputSchemaFile), 'utf8'),
        ) as unknown
      } catch (err) {
        console.error(`Cannot load output schema: ${(err as Error).message}`)
        process.exitCode = CLI_EXIT.usage
        return
      }
    }
  }
  // Directory-backed custom slash commands (.athena/commands, ~/.athena/commands). Name
  // collisions with a built-in command are skipped with a warning, never fatal.
  const commands = new Map(
    loadCommandsIndexWithPlugins(effectivePaths, (msg) => console.error(msg)).map((c) => [c.name, c]),
  )
  const pendingSemanticEvents: InteractionEventEnvelope[] = []
  const flushSemanticJsonl = () => {
    if (cmd.command !== 'exec' || cmd.options.output !== 'jsonl') return
    for (const event of pendingSemanticEvents.splice(0)) {
      process.stdout.write(
        JSON.stringify({
          schemaVersion: 1,
          event: { type: 'interaction-event', envelope: event },
        }) + '\n',
      )
    }
  }
  const bridge = new PermissionBridge()
  const permissionDetails = new Map<string, string>()
  // Session selection the controller cannot express as a bare id: `--continue` takes the
  // latest session for this project, `--resume` asks. Handed over as a callback so the
  // picker still mounts at the point in startup it always has — after the plugin, skill,
  // and agent warnings have printed on stderr rather than racing them onto its frame.
  const selectSession =
    cmd.command === 'continue'
      ? async (store: SessionStore) => {
          const latest = store.continueLatest()
          if (!latest) return null
          const found = store.list().find((s) => s.id === latest.id)
          if (!found) {
            console.error(
              `Session ${latest.id} disappeared while starting; starting a fresh session instead.`,
            )
            return null
          }
          return { id: latest.id, file: found.file, messages: latest.messages }
        }
      : cmd.command === 'resume'
        ? async (store: SessionStore) => {
            const picked = screenInput
              ? await pickSessionLine(store.list(), screenInput)
              : await pickSession(store.list())
            if (!picked) return null
            return { id: picked.id, file: picked.file, messages: store.resume(picked.id) }
          }
        : undefined
  // One session composition for every path: exec, the append-only screen-reader loop, the
  // Ink TUI below, and `athena voice` all build the same controller.
  const controller = await HarnessSessionController.create({
    paths,
    effectivePaths,
    cwd,
    provider,
    client: makeClient(provider, resolved.key, vmpRecorder),
    settings,
    projectTrust,
    limits: isExec ? cmd.options.limits : undefined,
    outputSchema,
    resumeId: isExec ? (cmd.options.resumeId ?? undefined) : undefined,
    persistSession: isExec ? cmd.options.persistSession : true,
    selectSession,
    askUser: isExec
      ? undefined
      : async (req) => {
          if (!screenPresentation) return bridge.ask(req)
          const diff = permissionDiff(req, cwd)
          if (diff) {
            permissionDetails.set(req.id, formatPermissionDiffDetail(diff))
            if (permissionDetails.size > 100) {
              permissionDetails.delete(permissionDetails.keys().next().value!)
            }
          }
          return screenPresentation.requestPermission(
            createAccessiblePermissionRequest({
              ...req,
              ...(diff ? { diff: permissionDiffStats(diff) } : {}),
            }),
          )
        },
    onAnnouncement: (announcement) => {
      // The richer permission prompt immediately follows its semantic blocker; reading
      // both aloud would announce one decision twice.
      if (announcement.category !== 'permission') screenPresentation?.announce(announcement)
    },
    onEnvelope: (event) => {
      if (cmd.command === 'exec' && cmd.options.output === 'jsonl') {
        pendingSemanticEvents.push(event)
      }
    },
  })
  const {
    bus,
    engine,
    gate,
    trace,
    interactionService,
    contextManager,
    orchestrator,
    client,
    session,
    sessionStore: store,
  } = controller

  if (isExec) {
    let permissionDenied = false
    let wroteText = false
    const unsubscribe = bus.on((event) => {
      if (
        event.type === 'tool-result' &&
        event.isError &&
        event.output.startsWith('Permission denied:')
      ) {
        permissionDenied = true
      }
      if (cmd.options.output === 'jsonl') {
        process.stdout.write(JSON.stringify({ schemaVersion: 1, event }) + '\n')
        flushSemanticJsonl()
      } else if (cmd.options.output === 'text') {
        if (event.type === 'assistant-text') {
          wroteText = true
          process.stdout.write(event.delta)
        } else if (event.type === 'error') {
          process.stderr.write(`${event.message}\n`)
        }
      }
    })
    let result: RunResult | undefined
    let output = ''
    let outputValue: unknown
    let schemaErrors: string[] = []
    let exitCode: number = CLI_EXIT.success
    try {
      result = await controller.runTurn(execPrompt!, {
        sourceRef: 'prompt:exec',
        beforeRun: flushSemanticJsonl,
      })
    } finally {
      await controller.close({
        reason: 'exec-complete',
        result,
        onDetach: unsubscribe,
        beforeTraceClose: () => {
          output = finalAssistantText(engine.getMessages())
          if (outputSchema !== null) {
            const validation = validateJsonOutput(output, outputSchema)
            outputValue = validation.value
            schemaErrors = validation.errors
          }
          if (schemaErrors.length > 0) exitCode = CLI_EXIT.outputSchema
          else if (permissionDenied) exitCode = CLI_EXIT.permission
          else if (result?.status === 'limit') exitCode = CLI_EXIT.limit
          else if (result?.status === 'aborted') exitCode = CLI_EXIT.aborted
          else if (result?.status === 'error') exitCode = CLI_EXIT.provider
        },
      })
    }
    const finalResult = result ?? engine.getRunResult()
    const envelope = {
      schemaVersion: 1,
      runId: trace.runId,
      sessionId: controller.sessionPersisted ? session.id : null,
      status: finalResult.status,
      reason: finalResult.reason,
      exitCode,
      output,
      outputValue,
      schemaErrors,
      usage: finalResult.usage,
      traceFile: trace.file,
    }
    if (cmd.options.output === 'json') {
      process.stdout.write(JSON.stringify(envelope) + '\n')
    } else if (cmd.options.output === 'jsonl') {
      process.stdout.write(
        JSON.stringify({ schemaVersion: 1, event: { type: 'exec-result', ...envelope } }) + '\n',
      )
    } else {
      if (wroteText) process.stdout.write('\n')
      if (!wroteText && output) process.stdout.write(output + '\n')
      if (schemaErrors.length > 0) {
        process.stderr.write(`Output schema failed: ${schemaErrors.join('; ')}\n`)
      }
    }
    process.exitCode = exitCode
    return
  }

  // Last-resort crash handlers: state is no longer trusted after an escaped
  // exception. Record a bounded diagnostic, cancel the active run, close MCP
  // transports, and terminate non-zero instead of continuing in undefined state.
  let crashing = false
  const crashHandler = (err: unknown) => {
    if (crashing) return
    crashing = true
    const message = err instanceof Error ? err.message : String(err)
    const stack = (err instanceof Error ? (err.stack ?? message) : message).slice(0, 100_000)
    try {
      appendFileSync(join(paths.brainDir, 'crash.log'), `${new Date().toISOString()} ${stack}\n`, 'utf8')
    } catch {
      /* the crash log failing must not itself crash */
    }
    bus.emit({ type: 'error', message: `Internal crash (logged to crash.log): ${message}`, fatal: true })
    engine.abort()
    void (async () => {
      await controller.close({ reason: 'crash', captureExperience: false }).catch(() => {})
      process.exit(1)
    })()
  }
  process.on('unhandledRejection', crashHandler)
  process.on('uncaughtException', crashHandler)

  const slashHandler = makeSlashHandler({
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
    runId: trace.runId,
    permissionDetails: (id) => permissionDetails.get(id) ?? null,
    commands,
    vmpRecorder,
  })

  if (screenPresentation && screenInput) {
    const unsubscribeScreen = bus.on((event) => {
      if (event.type === 'info') {
        screenPresentation.showDetails({ id: `info:${Date.now()}`, text: event.message })
      }
    })
    let activeTurn = false
    let exitRequested = false
    const onSigint = () => {
      const result = handleScreenReaderInterrupt(activeTurn, {
        abort: () => engine.abort(),
        cancelInput: () => screenPresentation.cancelPendingInput(),
        acknowledge: (accepted) => screenPresentation.acknowledgeCancellation(accepted),
        closeInput: () => screenInput.close(),
      })
      if (result === 'session-exit') exitRequested = true
    }
    process.on('SIGINT', onSigint)
    await screenPresentation.start(
      interactionService.snapshot(trace.runId) ??
        createInteractionSnapshot(trace.runId, new Date().toISOString()),
    )
    try {
      while (!exitRequested) {
        let text: string
        try {
          text = (await screenPresentation.prompt({ id: `prompt:${Date.now()}`, label: 'You' })).trim()
        } catch {
          break
        }
        if (!text) continue
        const slash = parseSlash(text, commands)
        const route = slash ? screenReaderCommandRoute(slash) : 'submit-prompt'
        if (route === 'exit') break
        if (route === 'append-only-clear') {
          bus.emit({
            type: 'info',
            message: 'Append-only screen-reader mode keeps native scrollback; nothing was cleared.',
          })
          continue
        }
        if (route === 'presentation-change' && slash?.kind === 'tui') {
          bus.emit({
            type: 'info',
            message: `Presentation changes take effect at startup. Restart with --accessibility ${slash.value === 'fullscreen' ? 'standard' : 'screen-reader'}.`,
          })
          continue
        }
        if (route === 'shared-handler' && slash) {
          slashHandler(slash)
          continue
        }
        const prompt = slash?.kind === 'custom' ? slash.expandedPrompt : text
        activeTurn = true
        try {
          await controller.runTurn(prompt)
          const output = finalAssistantText(engine.getMessages())
          if (output) screenPresentation.writeAssistantText(output)
        } catch (error) {
          bus.emit({ type: 'error', message: `Turn crashed: ${(error as Error).message}`, fatal: true })
        } finally {
          activeTurn = false
        }
      }
    } finally {
      process.off('SIGINT', onSigint)
      unsubscribeScreen()
      await screenPresentation.close(engine.getRunResult())
      await controller.close('interactive-exit')
    }
    return
  }

  const instance = render(
    React.createElement(App, {
      bus,
      status: {
        cwd,
        gitBranch: gitBranch(cwd),
        model: modelLabel(provider, settings.model),
        modelKey: settings.model,
        provider,
        effort: settings.effort,
        mode: gate.getMode(),
        contextPct: Math.round(contextManager.usedFraction() * 100),
      },
      onSubmit: async (text: string) => {
        await controller.runTurn(text)
      },
      onAbort: () => engine.abort(),
      permissionBridge: bridge,
      commands,
      agents: orchestrator.listDefs(),
      initialMessages: controller.initialMessages,
      onSlash: slashHandler,
    }),
  )
  // main() owns the TUI lifetime: an Ink render-phase failure rejects here and is
  // reported by the main().catch below instead of dying as an unhandled rejection.
  // close runs on the normal exit path (and on a render-phase error) so spawned
  // MCP server processes and background tasks are torn down rather than leaked.
  try {
    await instance.waitUntilExit()
  } finally {
    await controller.close('interactive-exit')
  }
}

// Run only when invoked as the CLI entry (bin/athena.js, tsx src/cli.ts, dist/cli.js) —
// importing this module from tests must not launch the TUI or scaffold ~/.athena.
const entryBase = process.argv[1] ? basename(process.argv[1]) : ''
if (['athena', 'athena.js', 'athena.cmd', 'cli.js', 'cli.mjs', 'cli.ts'].includes(entryBase)) {
  // Top-level error boundary: malformed settings.json, a vanished session file, etc.
  // must exit with a clean message, not an unhandled-rejection stack trace.
  main().catch((err: Error) => {
    console.error(err.message)
    process.exitCode = CLI_EXIT.internal
  })
}
