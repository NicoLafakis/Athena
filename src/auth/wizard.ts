// src/auth/wizard.ts — first-run and `athena auth` setup: pick provider, paste key
// (masked), validate with a minimal live call to the provider's cheapest model, save to
// ~/.athena/credentials.json, set activeProvider. Runs PRE-TUI (plain stdin/stdout —
// Ink is not mounted yet), so a manual raw-mode echo handler does the masking; Node's
// readline cannot mask input natively.
import { createInterface } from 'node:readline'
import { PROVIDERS, PROVIDER_IDS, modelId, type ProviderId } from '../brain/models.js'
import { setProviderKey } from '../brain/credentials.js'
import type { BrainPaths } from '../brain/paths.js'
import type { CredentialVault } from '../brain/credential-vault.js'
import { AnthropicClient } from '../engine/client.js'
import { OpenAIClient } from '../engine/openai-client.js'

export interface WizardIO {
  say(message: string): void
  pickProvider(): Promise<ProviderId>
  readKey(provider: ProviderId): Promise<string>
}

export interface TerminalWizardIOOptions {
  screenReader?: boolean
  ask?: (question: string) => Promise<string>
  readSecret?: (question: string, options?: PromptSecretOptions) => Promise<string>
}

/** null = key accepted; otherwise the provider's error message. */
export type ValidateFn = (provider: ProviderId, key: string) => Promise<string | null>

/** Live check: one minimal message to the provider's cheapest model. */
export async function validateKey(provider: ProviderId, key: string): Promise<string | null> {
  try {
    if (provider === 'openai') {
      // Reasoning models can burn a tiny cap before any visible text; 128 headroom
      // keeps a valid key from being falsely rejected on an empty completion.
      const client = new OpenAIClient(key, PROVIDERS[provider].baseURL ?? undefined)
      await client.complete({
        model: modelId(provider, PROVIDERS[provider].validationModel),
        prompt: 'hi',
        maxTokens: 128,
      })
      return null
    }
    const client = new AnthropicClient(
      key,
      PROVIDERS[provider].baseURL ?? undefined,
      PROVIDERS[provider].authMode,
    )
    await client.complete({
      model: modelId(provider, PROVIDERS[provider].validationModel),
      prompt: 'hi',
      maxTokens: 1,
    })
    return null
  } catch (err) {
    return (err as Error).message
  }
}

export async function runAuthWizard(opts: {
  paths: BrainPaths
  /** When set, the wizard is scoped to this provider and skips the provider pick. */
  provider?: ProviderId
  io?: WizardIO
  validate?: ValidateFn
  vault?: CredentialVault
}): Promise<{ provider: ProviderId; key: string }> {
  const io = opts.io ?? terminalIO()
  const validate = opts.validate ?? validateKey
  const provider = opts.provider ?? (await io.pickProvider())
  for (;;) {
    const key = (await io.readKey(provider)).trim()
    if (key === '') {
      io.say('Empty key - paste your API key (input is hidden).')
      continue
    }
    io.say(`Validating against ${PROVIDERS[provider].label}…`)
    const error = await validate(provider, key)
    if (error !== null) {
      // Providers with a keyHint (e.g. Kimi's .ai/.cn platform split) get it appended
      // so a rejected key comes with the likely cause, not just the raw error.
      const hint = PROVIDERS[provider].keyHint
      io.say(
        `Key rejected: ${error}\n${hint !== undefined ? `${hint}\n` : ''}Try again (Ctrl-C to abort).`,
      )
      continue
    }
    const warnings: string[] = []
    const saved = setProviderKey(opts.paths, provider, key, {
      vault: opts.vault,
      onWarn: (message) => warnings.push(message),
    })
    const destination = saved.providers[provider]?.vaultRef ? 'the OS credential vault' : opts.paths.credentialsFile
    for (const warning of warnings) io.say(warning)
    io.say(`Saved to ${destination}. Active provider: ${provider}.`)
    return { provider, key }
  }
}

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    let answered = false
    rl.question(question, (answer) => {
      answered = true
      rl.close()
      resolve(answer)
    })
    rl.on('close', () => {
      if (!answered) resolve('')
    })
  })
}

export type EscState = 'none' | 'esc' | 'csi'

/** Pure state transition for filtering ANSI escape sequences out of masked input.
 *  `consume` = the character belongs to an escape sequence and must never reach the key.
 *  After ESC (0x1b), an introducer '[' (CSI) or 'O' (SS3) opens a multi-byte sequence
 *  that terminates on the NEXT byte in the '@'-'~' range; any other byte after ESC is a
 *  single-char sequence, consumed as its final byte. (The introducers themselves sit
 *  inside '@'-'~', so a naive "terminate on @-~" check would end one byte early and
 *  leak e.g. the 'A' of 'ESC [ A' into the key.) */
export function escFilter(state: EscState, ch: string): { state: EscState; consume: boolean } {
  if (state === 'csi') {
    return { state: ch >= '@' && ch <= '~' ? 'none' : 'csi', consume: true }
  }
  if (state === 'esc') {
    return { state: ch === '[' || ch === 'O' ? 'csi' : 'none', consume: true }
  }
  if (ch.charCodeAt(0) === 27) return { state: 'esc', consume: true }
  return { state: 'none', consume: false }
}

export interface PromptSecretOptions {
  /** Screen readers must not announce one mask character per keypress. */
  echoMask?: boolean
}

/** Hidden input: raw mode, optional visual mask, handle backspace/Ctrl-C/Enter manually. */
export function promptMasked(
  question: string,
  options: PromptSecretOptions = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error('Masked input requires an interactive terminal - run athena from a real console.'))
      return
    }
    process.stdout.write(question)
    const stdin = process.stdin
    const wasRaw = stdin.isRaw ?? false
    stdin.setRawMode(true)
    stdin.resume()
    let value = ''
    let esc: EscState = 'none'
    const echoMask = options.echoMask ?? true
    const finish = (): void => {
      stdin.off('data', onData)
      stdin.setRawMode(wasRaw)
      stdin.pause()
      process.stdout.write('\n')
    }
    const onData = (chunk: Buffer): void => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          finish()
          resolve(value)
          return
        }
        if (ch === '\u0003') {
          // Ctrl-C: restore the terminal before dying, standard 130 exit code.
          finish()
          process.exit(130)
        }
        if (ch === '\u0004') {
          // Ctrl-D / EOF: restore the terminal and fail loud instead of hanging.
          finish()
          reject(new Error('Input closed before a key was entered.'))
          return
        }
        if (ch === '\u007f' || ch === '\b') {
          if (value.length > 0) {
            value = value.slice(0, -1)
            if (echoMask) process.stdout.write('\b \b')
          }
          continue
        }
        // CSI/escape sequences (arrow keys, paste-bracketing, etc.): the pure state
        // machine above swallows the whole sequence so none of it reaches the key.
        const step = escFilter(esc, ch)
        esc = step.state
        if (step.consume) continue
        if (ch < ' ' || ch === '\u007f') continue // other control chars: never into the key
        value += ch
        if (echoMask) process.stdout.write('*')
      }
    }
    stdin.on('data', onData)
  })
}

/** Terminal wizard factory. Screen-reader mode keeps secrets fully silent while typed. */
export function terminalIO(options: TerminalWizardIOOptions = {}): WizardIO {
  const askInput = options.ask ?? ask
  const readSecret = options.readSecret ?? promptMasked
  return {
    say: (m) => console.log(m),
    pickProvider: async () => {
      for (;;) {
        console.log('Pick a provider:')
        PROVIDER_IDS.forEach((p, i) => console.log(`  ${i + 1}. ${PROVIDERS[p].label}`))
        const answer = (await askInput('> ')).trim()
        const byIndex = PROVIDER_IDS[Number(answer) - 1]
        const byName = PROVIDER_IDS.find((p) => p === answer.toLowerCase())
        const picked = byName ?? byIndex
        if (picked) return picked
        console.log(`Unrecognized: ${answer}`)
      }
    },
    readKey: (p) => readSecret(
      `${PROVIDERS[p].label} API key (input hidden): `,
      { echoMask: !options.screenReader },
    ),
  }
}
