import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  playWindowsPcm,
  probeWindowsSpeech,
  recognizeWindowsPhrase,
  runPowerShell,
  stripWakePhrase,
} from '../../src/voice/windows-speech.js'

describe('Windows local speech backend', () => {
  it.runIf(process.platform === 'win32')(
    'round-trips a sentinel argument through the shipped PowerShell transport',
    async () => {
      await expect(runPowerShell('[Console]::Out.Write($args[0])', ['athena-sentinel']))
        .resolves.toBe('athena-sentinel')
    },
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
    await expect(recognizeWindowsPhrase(async () => '{"text":"Athena status","confidence":0.91}'))
      .resolves.toEqual({ text: 'Athena status', confidence: 0.91 })
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
      return '{"text":"Athena probe","confidence":0.91}'
    }, 10)
    expect(args).toEqual(['10'])
    expect(timeoutMs).toBe(20_000)
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
})
