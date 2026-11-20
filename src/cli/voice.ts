import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadCredentials, resolveApiKey, type Credentials } from '../brain/credentials.js'
import type { CredentialVault } from '../brain/credential-vault.js'
import { loadConstitution } from '../brain/loader.js'
import { PROVIDERS } from '../brain/models.js'
import type { BrainPaths } from '../brain/paths.js'
import { FileLedgerStore } from '../brain/vmp-ledger.js'
import { makeTelemetryRecorder } from '../engine/telemetry.js'
import { HarnessSessionController } from '../harness/controller.js'
import { CLI_EXIT, type CliCommand } from './args.js'
import { makeClient } from './client.js'
import { prepareSessionEnvironment } from './session-bootstrap.js'

export async function runVoiceCommand(
  cmd: Extract<CliCommand, { command: 'voice' }>,
  paths: BrainPaths,
  cwd: string,
  credentialVault: CredentialVault,
): Promise<void> {
  const {
    KeyboardVoiceCommandInput,
    VoiceAttentionBridge,
    VoiceTelemetry,
    WindowsPersistentWakeInput,
    ensureVoiceKey,
    playListeningCue,
    playStandbyCue,
    runVoiceProbe,
    runVoiceSession,
    saveVoiceKey,
    validateRealtimeKey,
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
      console.log(`Validating OpenAI Realtime access with ${cmd.model}…`)
      await validateRealtimeKey(key, { model: cmd.model })
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
        console.log(`Validating OpenAI Realtime access with ${cmd.model}…`)
        return validateRealtimeKey(key, { model: cmd.model })
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
    const controller = await HarnessSessionController.create({
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
    // Ctrl+C is the documented immediate keyboard fallback, and without a handler the
    // process dies before `controller.close` runs — losing the SessionEnd hook and the
    // trace's closing record, which are the evidence a shut-down session is meant to
    // keep. Abort the turn, release the microphone, and let the normal teardown run.
    // A second Ctrl+C is the hard escape for a teardown that is itself stuck.
    let voiceInterrupted = false
    function onVoiceSigint(): void {
      if (voiceInterrupted) {
        process.exit(CLI_EXIT.aborted)
        return
      }
      voiceInterrupted = true
      console.error('Athena voice stopping: aborting the current turn and closing the session.')
      controller.abort()
      voiceInput.close()
    }
    const voiceInput = cmd.keyboard
      ? new KeyboardVoiceCommandInput({ onInterrupt: onVoiceSigint })
      : new WindowsPersistentWakeInput({
          onWarn: (message) => console.error(message),
          telemetry: voiceTelemetry,
          onListening: () => {
            console.log('Athena: listening…')
            void playListeningCue().catch(() => {})
          },
        })
    process.on('SIGINT', onVoiceSigint)
    try {
      await runVoiceSession({
        apiKey: resolvedVoice.key,
        model: cmd.model,
        controller,
        attention,
        persona: loadConstitution(effectivePaths) ?? undefined,
        input: voiceInput,
        onStandby: cmd.keyboard
          ? undefined
          : () => {
              console.log('Athena: wake standby')
              void playStandbyCue().catch(() => {})
            },
        telemetry: voiceTelemetry,
      })
    } catch (error) {
      // An interrupt tears the wake listener down on purpose; reporting that as a voice
      // failure would send the user to `athena voice probe` for something they did.
      if (!voiceInterrupted) throw error
    } finally {
      process.off('SIGINT', onVoiceSigint)
      attention.close()
      await controller.close(voiceInterrupted ? 'interrupted' : 'shutdown')
    }
    if (voiceInterrupted) {
      console.log(
        `Athena voice stopped. Session ${controller.session.id} is preserved; ` +
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
