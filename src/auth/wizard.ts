// src/auth/wizard.ts — first-run and `athena auth` setup: pick provider, paste key
// (masked), validate with a minimal live call to the provider's cheapest model, save to
// ~/.athena/credentials.json, set activeProvider. Runs PRE-TUI (plain stdin/stdout —
// Ink is not mounted yet), so a manual raw-mode echo handler does the masking; Node's
// readline cannot mask input natively.
import { createInterface } from 'node:readline'
import { PROVIDERS, PROVIDER_IDS, modelId, type ProviderId } from '../brain/models.js'
import { setProviderKey } from '../brain/credentials.js'
import type { BrainPaths } from '../brain/paths.js'
import { AnthropicClient } from '../engine/client.js'

export interface WizardIO {
  say(message: string): void
  pickProvider(): Promise<ProviderId>
  readKey(provider: ProviderId): Promise<string>
}

/** null = key accepted; otherwise the provider's error message. */
export type ValidateFn = (provider: ProviderId, key: string) => Promise<string | null>

/** Live check: one minimal message to the provider's cheapest model. */
export async function validateKey(provider: ProviderId, key: string): Promise<string | null> {
  try {
    const client = new AnthropicClient(key, PROVIDERS[provider].baseURL ?? undefined)
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
      io.say(`Key rejected: ${error}\nTry again (Ctrl-C to abort).`)
      continue
    }
    setProviderKey(opts.paths, provider, key)
    io.say(`Saved to ${opts.paths.credentialsFile}. Active provider: ${provider}.`)
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

/** Masked input: raw mode, echo '*' per char, handle backspace/Ctrl-C/Enter manually. */
export function promptMasked(question: string): Promise<string> {
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
    let inEscape = false // inside an ANSI escape (ESC ... terminator in @-~)
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
            process.stdout.write('\b \b')
          }
          continue
        }
        // CSI/escape sequences (arrow keys, paste-bracketing, etc.): after ESC (0x1b),
        // swallow every byte until the terminator in the @-~ range so 'ESC [ A' never
        // leaks printable characters like '[' or 'A' into the key.
        if (inEscape) {
          if (ch >= '@' && ch <= '~') inEscape = false
          continue
        }
        if (ch.charCodeAt(0) === 27) {
          inEscape = true
          continue
        }
        if (ch < ' ' || ch === '\u007f') continue // other control chars: never into the key
        value += ch
        process.stdout.write('*')
      }
    }
    stdin.on('data', onData)
  })
}

function terminalIO(): WizardIO {
  return {
    say: (m) => console.log(m),
    pickProvider: async () => {
      for (;;) {
        console.log('Pick a provider:')
        PROVIDER_IDS.forEach((p, i) => console.log(`  ${i + 1}. ${PROVIDERS[p].label}`))
        const answer = (await ask('> ')).trim()
        const byIndex = PROVIDER_IDS[Number(answer) - 1]
        const byName = PROVIDER_IDS.find((p) => p === answer.toLowerCase())
        const picked = byName ?? byIndex
        if (picked) return picked
        console.log(`Unrecognized: ${answer}`)
      }
    },
    readKey: (p) => promptMasked(`${PROVIDERS[p].label} API key (input hidden): `),
  }
}
