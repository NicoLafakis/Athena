import { appendFileSync, existsSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { render } from 'ink'
import React from 'react'
import { loadCredentials, resolveApiKey, type Credentials } from '../brain/credentials.js'
import type { CredentialVault } from '../brain/credential-vault.js'
import { loadConstitution } from '../brain/loader.js'
import { modelLabel, PROVIDERS } from '../brain/models.js'
import { resolveBrainPaths, type BrainPaths } from '../brain/paths.js'
import { loadCommandsIndexWithPlugins } from '../brain/plugins.js'
import { FileLedgerStore } from '../brain/vmp-ledger.js'
import { makeTelemetryRecorder } from '../engine/telemetry.js'
import { HarnessSessionController } from '../harness/controller.js'
import { gitBranch } from '../harness/git.js'
import { App, PermissionBridge } from '../tui/App.js'
import { VoiceHud } from '../tui/VoiceHud.js'
import { CLI_EXIT, type CliCommand } from './args.js'
import { makeClient } from './client.js'
import { prepareSessionEnvironment } from './session-bootstrap.js'
import { makeSlashHandler } from './slash.js'

export async function runVoiceCommand(
  cmd: Extract<CliCommand, { command: 'voice' }>,
  paths: BrainPaths,
  cwd: string,
  credentialVault: CredentialVault,
): Promise<void> {
  const {
    KeyboardVoiceCommandInput,
    VoiceAttentionBridge,
    VoiceHudStore,
    VoiceTelemetry,
    WindowsDirectPcmInput,
    WindowsDuplexAudio,
    WindowsPersistentWakeInput,
    createInitialVoiceHudState,
    ensureVoiceKey,
    isLiveSessionModel,
    playListeningCue,
    playStandbyCue,
    playWindowsPcm,
    runLiveVoiceSession,
    runVoiceProbe,
    runVoiceSession,
    saveVoiceKey,
    validateVoiceKey,
  } = await import('../voice/index.js')
  const promptVisibleLine = async (question: string): Promise<string> => {
    const { createInterface } = await import('node:readline/promises')
    const reader = createInterface({ input: process.stdin, output: process.stdout })
    try {
      return (await reader.question(question)).trim()
    } finally {
      reader.close()
    }
  }
  const VOICE_KEY_PROMPT =
    'Paste your OpenAI API key and press Enter ' +
    '(visible while pasting; validated, then stored in your OS credential vault): '
  if (cmd.action === 'auth') {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.error('athena voice auth needs an interactive terminal.')
      process.exitCode = CLI_EXIT.usage
      return
    }
    try {
      const key = await promptVisibleLine(VOICE_KEY_PROMPT)
      if (!key) throw new Error('No key entered; nothing was changed.')
      console.log(`Validating OpenAI voice access with ${cmd.model}…`)
      await validateVoiceKey(key, { model: cmd.model })
      saveVoiceKey(credentialVault, key)
      console.log('OpenAI voice key saved to the OS credential vault and verified by readback.')
    } catch (error) {
      console.error((error as Error).message)
      process.exitCode = CLI_EXIT.provider
    }
    return
  }
  let resolvedVoice
  try {
    resolvedVoice = await ensureVoiceKey({
      env: process.env,
      vault: credentialVault,
      onWarn: (message) => console.error(message),
      validate: (key) => {
        console.log(`Validating OpenAI voice access with ${cmd.model}…`)
        return validateVoiceKey(key, { model: cmd.model })
      },
      ...(process.stdin.isTTY && process.stdout.isTTY
        ? {
            prompt: () =>
              promptVisibleLine(
                `No OpenAI voice key is configured on this machine yet.\n${VOICE_KEY_PROMPT}`,
              ),
          }
        : {}),
    })
  } catch (error) {
    console.error((error as Error).message)
    process.exitCode = CLI_EXIT.provider
    return
  }
  if (!resolvedVoice) {
    console.error(
      'No OpenAI voice key found. Set OPENAI_API_KEY, or run `athena voice` ' +
        'in an interactive terminal to paste one.',
    )
    process.exitCode = CLI_EXIT.provider
    return
  }
  try {
    if (cmd.action === 'probe') {
      for (const line of await runVoiceProbe(resolvedVoice.key, cmd.model)) console.log(line)
      return
    }
    if (!process.stdout.isTTY || (cmd.keyboard && !process.stdin.isTTY)) {
      console.error('athena voice needs an interactive terminal; use normal `athena exec` for redirection.')
      process.exitCode = CLI_EXIT.usage
      return
    }
    let credentials: Credentials
    try {
      credentials = loadCredentials(paths)
    } catch (err) {
      console.error((err as Error).message)
      process.exitCode = 1
      return
    }
    const provider = credentials.activeProvider
    const { projectTrust, effectivePaths, settings } = await prepareSessionEnvironment({
      paths,
      cwd,
      provider,
      interactiveTrust: false,
      applyTrust: true,
      warn: (msg) => console.error(msg),
    })
    const voiceVmpLedger = settings.vmp.enabled ? FileLedgerStore.forPaths(paths) : undefined
    const voiceVmpRecorder = makeTelemetryRecorder(voiceVmpLedger)
    const resolvedKey = resolveApiKey(provider, credentials, process.env, credentialVault, () => {})
    if (!resolvedKey) {
      console.error(`No API key found for ${PROVIDERS[provider].label}; run \`athena auth\`.`)
      process.exitCode = CLI_EXIT.provider
      return
    }
    const harnessClient = makeClient(provider, resolvedKey.key, voiceVmpRecorder)
    const usageFile = join(paths.brainDir, 'voice-usage.jsonl')
    // Cost, latency, and lifecycle meters — scalars and IDs only, never a transcript.
    // Constructed before the bridge and the wake listener because both report into it.
    const voiceTelemetry = new VoiceTelemetry({
      model: cmd.model,
      artifact: 'voice-usage.jsonl',
      write: (line) => appendFileSync(usageFile, line, { encoding: 'utf8', mode: 0o600 }),
      onWarn: (message) => console.error(message),
    })
    // Running `athena voice` is itself a request for spoken output, so `directSpeech:
    // off` (the TUI default) becomes `supplemental` here rather than muting the one
    // mode with no screen to fall back on. Supplemental still yields routine speech to
    // an active screen reader and keeps blocking states audible.
    const attention = new VoiceAttentionBridge({
      cwd,
      ownership:
        settings.accessibility.directSpeech === 'off'
          ? 'supplemental'
          : settings.accessibility.directSpeech,
      screenReaderActive: settings.accessibility.presentation === 'screen-reader',
      telemetry: voiceTelemetry,
    })
    let activeController = await HarnessSessionController.create({
      paths,
      effectivePaths,
      cwd,
      provider,
      client: harnessClient,
      settings,
      projectTrust,
      persistSession: true,
      askUser: attention.askUser,
      onAnnouncement: (announcement) => attention.announce(announcement),
    })

    const switchProject = async (requestedPath: string) => {
      const targetCwd = resolve(activeController.cwd, requestedPath)
      if (!existsSync(targetCwd) || !statSync(targetCwd).isDirectory()) {
        return { ok: false as const, error: `Directory does not exist: ${targetCwd}` }
      }
      const carriedHistory = activeController.engine.getMessages().slice(-20)
      await activeController.close('project-switch')
      const nextPaths = resolveBrainPaths({ cwd: targetCwd })
      const nextEnv = await prepareSessionEnvironment({
        paths: nextPaths,
        cwd: targetCwd,
        provider,
        interactiveTrust: false,
        applyTrust: true,
        warn: (msg) => console.error(msg),
      })
      activeController = await HarnessSessionController.create({
        paths: nextPaths,
        effectivePaths: nextEnv.effectivePaths,
        cwd: targetCwd,
        provider,
        client: harnessClient,
        settings: nextEnv.settings,
        projectTrust: nextEnv.projectTrust,
        persistSession: true,
        askUser: attention.askUser,
        onAnnouncement: (announcement) => attention.announce(announcement),
      })
      if (carriedHistory.length > 0) {
        activeController.engine.loadMessages(carriedHistory)
      }
      const isProjectRoot = existsSync(join(targetCwd, '.git')) || existsSync(join(targetCwd, '.athena'))
      return {
        ok: true as const,
        cwd: targetCwd,
        projectName: basename(targetCwd) || targetCwd,
        ...(!isProjectRoot ? { warning: 'This directory has no .git or .athena folder.' } : {}),
      }
    }

    let tuiInstance: ReturnType<typeof render> | null = null
    let hudStore: InstanceType<typeof VoiceHudStore> | null = null
    const useVoiceHud =
      !cmd.tui &&
      !cmd.keyboard &&
      settings.accessibility.presentation !== 'screen-reader' &&
      process.stdin.isTTY &&
      process.stdout.isTTY

    if (useVoiceHud) {
      hudStore = new VoiceHudStore(
        createInitialVoiceHudState({
          model: cmd.model,
          projectName: basename(activeController.cwd) || activeController.cwd,
        }),
      )
      tuiInstance = render(React.createElement(VoiceHud, { store: hudStore }))
    } else if (cmd.tui && process.stdin.isTTY && process.stdout.isTTY) {
      const commands = new Map(loadCommandsIndexWithPlugins(effectivePaths).map((c) => [c.name, c]))
      const bridge = new PermissionBridge()
      const slashHandler = makeSlashHandler({
        bus: activeController.bus,
        engine: activeController.engine,
        gate: activeController.gate,
        contextManager: activeController.contextManager,
        client: activeController.client,
        store: activeController.sessionStore,
        session: activeController.session,
        paths,
        credentialVault,
        interactionService: activeController.interactionService,
        runId: activeController.trace.runId,
        commands,
        vmpRecorder: voiceVmpRecorder,
        continuityStore: activeController.continuityStore,
        ...(settings.timeZone ? { timeZone: settings.timeZone } : {}),
      })
      tuiInstance = render(
        React.createElement(App, {
          bus: activeController.bus,
          status: {
            cwd: activeController.cwd,
            gitBranch: gitBranch(activeController.cwd),
            model: modelLabel(provider, settings.model),
            modelKey: settings.model,
            provider,
            effort: settings.effort,
            mode: activeController.gate.getMode(),
            contextPct: Math.round(activeController.contextManager.usedFraction() * 100),
          },
          onSubmit: async (text: string) => {
            await activeController.runTurn(text)
          },
          onAbort: () => activeController.abort(),
          permissionBridge: bridge,
          commands,
          agents: activeController.orchestrator.listDefs(),
          initialMessages: activeController.initialMessages,
          onSlash: slashHandler,
        }),
      )
    }

    // Ctrl+C is the documented immediate keyboard fallback, and without a handler the
    // process dies before `controller.close` runs — losing the SessionEnd hook and the
    // trace's closing record, which are the evidence a shut-down session is meant to
    // keep. Abort the turn, release the microphone, and let the normal teardown run.
    // A second Ctrl+C is the hard escape for a teardown that is itself stuck.
    const useFullDuplexLive = isLiveSessionModel(cmd.model) && !cmd.keyboard && !cmd.wakeWord
    const liveAbort = new AbortController()
    let voiceInterrupted = false
    let closeInput: () => void = () => liveAbort.abort()
    function onVoiceSigint(): void {
      if (voiceInterrupted) {
        process.exit(CLI_EXIT.aborted)
        return
      }
      voiceInterrupted = true
      console.error('Athena voice stopping: aborting the current turn and closing the session.')
      activeController.abort()
      closeInput()
    }
    process.on('SIGINT', onVoiceSigint)
    try {
      if (useFullDuplexLive) {
        await runLiveVoiceSession({
          apiKey: resolvedVoice.key,
          model: cmd.model,
          duplex: new WindowsDuplexAudio(),
          persona: loadConstitution(effectivePaths) ?? undefined,
          signal: liveAbort.signal,
          onReady: (backend) => {
            hudStore?.dispatch({ type: 'phase', phase: 'standby' })
            hudStore?.dispatch({
              type: 'status',
              text: `Live full-duplex (${backend}) — speak naturally anytime`,
            })
          },
          onMicLevel: (level) => {
            hudStore?.dispatch({ type: 'mic-level', level })
          },
          onAthenaLevel: (level) => {
            hudStore?.dispatch({ type: 'athena-level', level })
          },
          onUserHypothesis: (text) => {
            hudStore?.dispatch({ type: 'hypothesis', text })
          },
          onUserTranscript: (text) => {
            hudStore?.dispatch({ type: 'feed', role: 'user', text })
            if (!hudStore && !tuiInstance) console.log(`You: ${text}`)
          },
          onAthenaTranscript: (text) => {
            hudStore?.dispatch({ type: 'feed', role: 'athena', text })
            if (!hudStore && !tuiInstance) console.log(`Athena: ${text}`)
          },
          onAthenaSpeaking: (speaking) => {
            hudStore?.dispatch({ type: 'phase', phase: speaking ? 'speaking' : 'standby' })
            hudStore?.dispatch({
              type: 'status',
              text: speaking ? 'Speaking… (interrupt anytime)' : 'Live full-duplex — speak naturally',
            })
          },
          onStatus: (text) => {
            hudStore?.dispatch({ type: 'status', text })
          },
          onWarn: (message) => {
            if (hudStore) {
              hudStore.dispatch({ type: 'feed', role: 'system', text: message })
            } else {
              console.error(message)
            }
          },
          onDelegateStart: ({ id, prompt }) => {
            hudStore?.dispatch({
              type: 'handoff-start',
              id,
              label: prompt,
              target: 'Athena Harness',
            })
            hudStore?.dispatch({ type: 'status', text: 'Handed off to Athena Harness…' })
          },
          onDelegateEnd: ({ id, status, detail }) => {
            hudStore?.dispatch({ type: 'handoff-end', id, status, detail })
            hudStore?.dispatch({
              type: 'status',
              text: status === 'completed' ? 'Harness returned — speaking result…' : 'Harness task failed',
            })
          },
          onDelegate: async (prompt) => {
            const res = await activeController.submitTurn(prompt)
            return res.summary
          },
        })
      } else {
        const voiceInput = cmd.keyboard
          ? new KeyboardVoiceCommandInput({ onInterrupt: onVoiceSigint })
          : !cmd.wakeWord
            ? new WindowsDirectPcmInput({
                onReady: (backend) => {
                  hudStore?.dispatch({ type: 'phase', phase: 'standby' })
                  hudStore?.dispatch({
                    type: 'status',
                    text: `Mic open (${backend}) — speak anytime`,
                  })
                },
                onAudioLevel: (level) => {
                  hudStore?.dispatch({ type: 'mic-level', level })
                },
                onSpeechStart: () => {
                  hudStore?.dispatch({ type: 'phase', phase: 'hearing' })
                  hudStore?.dispatch({ type: 'status', text: 'Listening…' })
                },
                onUtteranceCaptured: () => {
                  hudStore?.dispatch({ type: 'phase', phase: 'working' })
                  hudStore?.dispatch({ type: 'status', text: 'Transcribing & thinking…' })
                },
                onWarn: (message) => {
                  if (hudStore) {
                    hudStore.dispatch({ type: 'feed', role: 'system', text: message })
                  } else {
                    console.error(message)
                  }
                },
              })
            : new WindowsPersistentWakeInput({
                requireWakeWord: true,
                onReady: (recognizer) => {
                  hudStore?.dispatch({ type: 'phase', phase: 'standby' })
                  hudStore?.dispatch({
                    type: 'status',
                    text: `Mic open (${recognizer ?? 'Windows Speech'}) — say "Athena"`,
                  })
                },
                onAudioLevel: (level) => {
                  hudStore?.dispatch({ type: 'mic-level', level })
                },
                onSpeechDetected: () => {
                  hudStore?.dispatch({ type: 'phase', phase: 'hearing' })
                },
                onHypothesis: (text) => {
                  hudStore?.dispatch({ type: 'hypothesis', text })
                },
                onUserUtterance: (text) => {
                  hudStore?.dispatch({ type: 'feed', role: 'user', text })
                  hudStore?.dispatch({ type: 'phase', phase: 'working' })
                  hudStore?.dispatch({ type: 'status', text: 'Thinking…' })
                },
                onRejected: (text, confidence) => {
                  hudStore?.dispatch({ type: 'phase', phase: 'standby' })
                  hudStore?.dispatch({
                    type: 'feed',
                    role: 'system',
                    text: text
                      ? `Heard "${text}" (${Math.round(confidence * 100)}% — ignored, say "Athena …")`
                      : 'Heard audio that did not match "Athena …"',
                  })
                },
                onWarn: (message) => {
                  if (hudStore) {
                    hudStore.dispatch({ type: 'feed', role: 'system', text: message })
                  } else {
                    console.error(message)
                  }
                },
                telemetry: voiceTelemetry,
                onListening: () => {
                  if (hudStore) {
                    hudStore.dispatch({ type: 'phase', phase: 'hearing' })
                    hudStore.dispatch({ type: 'status', text: 'Wake word heard — listening for command…' })
                  } else if (!tuiInstance) {
                    console.log('Athena: listening…')
                  }
                  void playListeningCue().catch(() => {})
                },
              })
        closeInput = () => voiceInput.close()
        await runVoiceSession({
          apiKey: resolvedVoice.key,
          model: cmd.model,
          controller: activeController,
          getController: () => activeController,
          switchProject: async (requestedPath) => {
            const result = await switchProject(requestedPath)
            if (result.ok) {
              hudStore?.dispatch({ type: 'project', projectName: result.projectName })
              hudStore?.dispatch({ type: 'feed', role: 'system', text: `Switched project -> ${result.cwd}` })
            }
            return result
          },
          attention,
          persona: loadConstitution(effectivePaths) ?? undefined,
          input: voiceInput,
          ...(hudStore
            ? {
                onHandoffStart: ({ id, label }) => {
                  hudStore.dispatch({
                    type: 'handoff-start',
                    id,
                    label,
                    target: 'Athena Harness',
                  })
                },
                onHandoffEnd: ({ id, status, detail }) => {
                  hudStore.dispatch({ type: 'handoff-end', id, status, detail })
                },
                onUserTranscript: (text) => {
                  hudStore.dispatch({ type: 'feed', role: 'user', text })
                },
                onStatus: (message) => {
                  if (message.startsWith('Athena: ')) {
                    hudStore.dispatch({ type: 'feed', role: 'athena', text: message.slice(8) })
                  } else {
                    hudStore.dispatch({ type: 'status', text: message })
                  }
                },
                play: async (audio) => {
                  const stopAnim = hudStore.animateAthenaPcm(audio)
                  try {
                    await playWindowsPcm(audio)
                  } finally {
                    stopAnim()
                  }
                },
              }
            : {}),
          onStandby: cmd.keyboard
            ? undefined
            : () => {
                if (hudStore) {
                  hudStore.dispatch({ type: 'phase', phase: 'standby' })
                  hudStore.dispatch({
                    type: 'status',
                    text: cmd.wakeWord ? 'Ready — say "Athena"' : 'Ready — speak anytime',
                  })
                } else if (!tuiInstance) {
                  console.log('Athena: wake standby')
                }
                void playStandbyCue().catch(() => {})
              },
          telemetry: voiceTelemetry,
        })
      }
    } catch (error) {
      // An interrupt tears the wake listener down on purpose; reporting that as a voice
      // failure would send the user to `athena voice probe` for something they did.
      if (!voiceInterrupted) throw error
    } finally {
      process.off('SIGINT', onVoiceSigint)
      tuiInstance?.unmount()
      attention.close()
      await activeController.close(voiceInterrupted ? 'interrupted' : 'shutdown')
    }
    if (voiceInterrupted) {
      console.log(
        `Athena voice stopped. Session ${activeController.session.id} is preserved; ` +
          'pick it up with `athena --resume`.',
      )
      process.exitCode = CLI_EXIT.aborted
    }
  } catch (error) {
    console.error(
      `Athena voice stopped: ${(error as Error).message} ` +
        'Run `athena voice probe` to test microphone, playback, and Realtime access.',
    )
    process.exitCode = CLI_EXIT.provider
  }
}
