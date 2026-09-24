import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  cueTonePcm,
  playListeningCue,
  playWindowsPcm,
  probeWindowsSpeech,
  realtimePcmFromWave,
  recognizeWindowsPhrase,
  runPowerShell,
  spawnWindowsWakeListener,
  stripWakePhrase,
} from '../../src/voice/windows-speech.js'

function pcmWave(sampleRate = 16_000, samples = [0, 1, -1, 2]): Buffer {
  const pcm = Buffer.alloc(samples.length * 2)
  samples.forEach((sample, index) => pcm.writeInt16LE(sample, index * 2))
  const wave = Buffer.alloc(44 + pcm.length)
  wave.write('RIFF', 0)
  wave.writeUInt32LE(36 + pcm.length, 4)
  wave.write('WAVEfmt ', 8)
  wave.writeUInt32LE(16, 16)
  wave.writeUInt16LE(1, 20)
  wave.writeUInt16LE(1, 22)
  wave.writeUInt32LE(sampleRate, 24)
  wave.writeUInt32LE(sampleRate * 2, 28)
  wave.writeUInt16LE(2, 32)
  wave.writeUInt16LE(16, 34)
  wave.write('data', 36)
  wave.writeUInt32LE(pcm.length, 40)
  pcm.copy(wave, 44)
  return wave
}

describe('Windows local speech backend', () => {
  it.runIf(process.platform === 'win32')(
    'round-trips a sentinel argument through the shipped PowerShell transport',
    async () => {
      await expect(runPowerShell('[Console]::Out.Write($args[0])', ['athena-sentinel']))
        .resolves.toBe('athena-sentinel')
    },
    // runPowerShell permits 45 seconds for a cold PowerShell startup; keep the test
    // timeout above that contract so CI reports the subprocess result, not Vitest's cap.
    60_000,
  )

  it('uses a real probe result instead of inferring support from the platform', async () => {
    await expect(probeWindowsSpeech(async () => '{"recognizers":1,"voices":2,"recognizer":"English","voice":"Zira"}', 'win32'))
      .resolves.toMatchObject({
        available: true,
        recognizers: 1,
        voices: 2,
        recognizer: 'English',
        voice: 'Zira',
      })
    await expect(probeWindowsSpeech(async () => '{"recognizers":0,"voices":2}', 'win32'))
      .resolves.toMatchObject({ available: false })
    await expect(probeWindowsSpeech(async () => '', 'linux'))
      .resolves.toMatchObject({ available: false, backend: 'unavailable' })
  })

  it('gates commands on the local Athena wake phrase', async () => {
    expect(stripWakePhrase('Athena, run the tests')).toBe('run the tests')
    expect(stripWakePhrase('athena status')).toBe('status')
    expect(stripWakePhrase('run the tests')).toBeNull()
    const wave = pcmWave().toString('base64')
    await expect(recognizeWindowsPhrase(async () => JSON.stringify({
      text: 'Athena status', confidence: 0.91, wave,
    }))).resolves.toMatchObject({ text: 'Athena status', confidence: 0.91 })
    await expect(recognizeWindowsPhrase(async () => {
      throw Object.assign(new Error('nothing heard'), { code: 2 })
    })).resolves.toBeNull()
  })

  it('bounds the requested recognition window and subprocess timeout', async () => {
    let args: readonly string[] | undefined
    let timeoutMs: number | undefined
    await recognizeWindowsPhrase(async (_script, observedArgs, observedTimeoutMs) => {
      args = observedArgs
      timeoutMs = observedTimeoutMs
      return JSON.stringify({
        text: 'Athena probe', confidence: 0.91, wave: pcmWave().toString('base64'),
      })
    }, 10)
    expect(args).toEqual(['10'])
    expect(timeoutMs).toBe(20_000)
  })

  it('downmixes and resamples captured Windows PCM for Realtime instead of trusting dictation text', () => {
    const pcm = realtimePcmFromWave(pcmWave(16_000, Array.from({ length: 160 }, (_, i) => i)))
    expect(pcm.length).toBe(480)
    expect(pcm.readInt16LE(0)).toBe(0)
    expect(() => realtimePcmFromWave(Buffer.from('not a wave'))).toThrow(/malformed audio/)
  })

  it('wraps Realtime PCM in a temporary WAV and removes it after synchronous playback', async () => {
    let header = ''
    let observedPath = ''
    await playWindowsPcm(Buffer.from([0, 0, 1, 0]), async (_script, args) => {
      observedPath = args?.[0] ?? ''
      header = (await readFile(observedPath)).subarray(0, 12).toString('ascii')
      return ''
    })
    expect(header).toBe('RIFF(\u0000\u0000\u0000WAVE')
    await expect(readFile(observedPath)).rejects.toThrow()
  })

  it.runIf(process.platform === 'win32')(
    'runs one persistent listener process: ready round trip, JSONL phrase events, clean exit',
    async (ctx) => {
      const probe = await probeWindowsSpeech()
      if (!probe.available) ctx.skip()
      // Synthesize the wake command locally; the WAV sentinel drives the exact
      // production script, so no microphone is needed to prove the continuous path.
      const directory = await mkdtemp(join(tmpdir(), 'athena-voice-test-'))
      const waveFile = join(directory, 'wake.wav')
      try {
        await runPowerShell(String.raw`
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Speech
$synth=New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $synth.SetOutputToWaveFile($args[0])
  $synth.Speak('Athena status')
} finally { $synth.Dispose() }
`, [waveFile], 30_000)

        const child = spawnWindowsWakeListener(waveFile)
        const lines: Array<Record<string, unknown>> = []
        let stderrTail = ''
        let buffered = ''
        child.stdout!.on('data', (chunk: Buffer) => {
          buffered += chunk.toString('utf8')
          const parts = buffered.split(/\r?\n/)
          buffered = parts.pop() ?? ''
          for (const part of parts) {
            try {
              lines.push(JSON.parse(part) as Record<string, unknown>)
            } catch {
              // Non-JSON console noise carries no wake events.
            }
          }
        })
        child.stderr!.on('data', (chunk: Buffer) => {
          stderrTail = (stderrTail + chunk.toString('utf8')).slice(-512)
        })
        let earlyExit: number | null = null
        const sawPhrase = await new Promise<boolean>((resolve) => {
          const cleanup = (): void => {
            clearTimeout(timer)
            clearInterval(poll)
          }
          const timer = setTimeout(() => {
            cleanup()
            resolve(false)
          }, 45_000)
          timer.unref?.()
          const poll = setInterval(() => {
            const ready = lines.some((line) => line.ready === true)
            const phrase = lines.some((line) =>
              typeof line.text === 'string' && /^athena\b/i.test(line.text) && typeof line.wave === 'string')
            if (ready && phrase) {
              cleanup()
              resolve(true)
            }
          }, 50)
          poll.unref?.()
          child.once('exit', (code) => {
            earlyExit = code
            cleanup()
            resolve(false)
          })
        })
        expect(
          sawPhrase,
          `expected ready + wake phrase lines (early exit: ${earlyExit ?? 'none'}; ` +
          `lines seen: ${lines.map((line) => Object.keys(line).join('+')).join(', ') || 'none'}; ` +
          `stderr: ${stderrTail.trim() || 'none'})`,
        ).toBe(true)
        child.stdin!.write('exit\n')
        child.stdin!.end()
        const exitCode = await new Promise<number | null>((resolve) => {
          const killTimer = setTimeout(() => {
            child.kill()
            const deadTimer = setTimeout(() => resolve(-1), 5_000)
            deadTimer.unref?.()
            child.once('exit', (code) => {
              clearTimeout(deadTimer)
              resolve(code)
            })
          }, 10_000)
          killTimer.unref?.()
          child.once('exit', (code) => {
            clearTimeout(killTimer)
            resolve(code)
          })
        })
        expect(exitCode).toBe(0)
      } finally {
        await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
          .catch((error) => console.error(`test cleanup: ${(error as Error).message}`))
      }
    },
    90_000,
  )

  it('synthesizes bounded, click-free cue tones and plays them as a WAV', async () => {
    const pcm = cueTonePcm([880, 1_320], 90)
    // Two 90 ms tones plus one 30 ms gap at 24 kHz, 16-bit mono.
    expect(pcm.length).toBe((2 * 2_160 + 720) * 2)
    let peak = 0
    let nonzero = 0
    for (let i = 0; i < pcm.length; i += 2) {
      const sample = Math.abs(pcm.readInt16LE(i))
      peak = Math.max(peak, sample)
      if (sample > 0) nonzero++
    }
    expect(peak).toBeLessThanOrEqual(Math.ceil(0.23 * 32_767))
    expect(nonzero).toBeGreaterThan(1_000)
    let header = ''
    await playListeningCue(async (_script, args) => {
      header = (await readFile(args?.[0] ?? '')).subarray(0, 4).toString('ascii')
      return ''
    })
    expect(header).toBe('RIFF')
  })

  it.runIf(process.platform === 'win32')(
    'emits recognized dictation without the wake word (the post-wake command path)',
    async (ctx) => {
      const probe = await probeWindowsSpeech()
      if (!probe.available) ctx.skip()
      const directory = await mkdtemp(join(tmpdir(), 'athena-voice-test-'))
      const waveFile = join(directory, 'command.wav')
      try {
        await runPowerShell(String.raw`
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Speech
$synth=New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $synth.SetOutputToWaveFile($args[0])
  $synth.Speak('status')
} finally { $synth.Dispose() }
`, [waveFile], 30_000)

        const child = spawnWindowsWakeListener(waveFile)
        let buffered = ''
        let stderrTail = ''
        const lines: Array<Record<string, unknown>> = []
        child.stdout!.on('data', (chunk: Buffer) => {
          buffered += chunk.toString('utf8')
          const parts = buffered.split(/\r?\n/)
          buffered = parts.pop() ?? ''
          for (const part of parts) {
            try {
              lines.push(JSON.parse(part) as Record<string, unknown>)
            } catch {
              // Non-JSON console noise carries no wake events.
            }
          }
        })
        child.stderr!.on('data', (chunk: Buffer) => {
          stderrTail = (stderrTail + chunk.toString('utf8')).slice(-512)
        })
        let earlyExit: number | null = null
        const sawCommand = await new Promise<boolean>((resolve) => {
          const cleanup = (): void => {
            clearTimeout(timer)
            clearInterval(poll)
          }
          const timer = setTimeout(() => {
            cleanup()
            resolve(false)
          }, 45_000)
          timer.unref?.()
          const poll = setInterval(() => {
            const ready = lines.some((line) => line.ready === true)
            const command = lines.some((line) =>
              typeof line.text === 'string' && /status/i.test(line.text))
            if (ready && command) {
              cleanup()
              resolve(true)
            }
          }, 50)
          poll.unref?.()
          child.once('exit', (code) => {
            earlyExit = code
            cleanup()
            resolve(false)
          })
        })
        expect(
          sawCommand,
          `expected a free-dictation phrase line for the wake-word-free command ` +
          `(early exit: ${earlyExit ?? 'none'}; lines: ${lines.map((line) => Object.keys(line).join('+')).join(', ') || 'none'}; ` +
          `stderr: ${stderrTail.trim() || 'none'})`,
        ).toBe(true)
        child.stdin!.write('exit\n')
        child.stdin!.end()
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            child.kill()
            resolve()
          }, 10_000)
          timer.unref?.()
          child.once('exit', () => {
            clearTimeout(timer)
            resolve()
          })
        })
      } finally {
        await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
          .catch((error) => console.error(`test cleanup: ${(error as Error).message}`))
      }
    },
    90_000,
  )
})
