import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const POWERSHELL_TIMEOUT_MS = 45_000

function encodedPowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

export interface SpeechBackendProbe {
  backend: 'windows-system-speech' | 'unavailable'
  available: boolean
  recognizers: number
  voices: number
  recognizer: string | null
  voice: string | null
  detail: string
}

export interface RecognizedPhrase {
  text: string
  confidence: number
  /** 24 kHz, mono, signed 16-bit little-endian PCM for OpenAI Realtime. */
  audio: Buffer
}

export type PowerShellRunner = (
  script: string,
  args?: readonly string[],
  timeoutMs?: number,
) => Promise<string>

export function runPowerShell(
  script: string,
  args: readonly string[] = [],
  timeoutMs = POWERSHELL_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const encodedArgs = Buffer.from(JSON.stringify(args), 'utf8').toString('base64')
    const argumentPrelude = String.raw`
$athenaVoiceArgsJson=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:ATHENA_VOICE_PS_ARGS))
$args=[string[]]($athenaVoiceArgsJson|ConvertFrom-Json)
`
    execFile(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        encodedPowerShell(`${argumentPrelude}\n${script}`),
      ],
      {
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, ATHENA_VOICE_PS_ARGS: encodedArgs },
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || error.message).split(/\r?\n/, 1)[0]?.trim()
          reject(Object.assign(
            new Error(detail || 'Windows speech backend failed'),
            { code: (error as NodeJS.ErrnoException & { code?: string | number }).code },
          ))
          return
        }
        resolve(stdout.trim())
      },
    )
  })
}

const PROBE_SCRIPT = String.raw`
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Speech
$installedRecognizers=[System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()
$recognizers=$installedRecognizers.Count
$recognizer=if ($recognizers -gt 0) { $installedRecognizers[0].Description } else { $null }
$synth=New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $installedVoices=$synth.GetInstalledVoices()
  $voices=$installedVoices.Count
  $preferred=$installedVoices | Where-Object {
    $_.Enabled -and $_.VoiceInfo.Gender -eq [System.Speech.Synthesis.VoiceGender]::Female
  } | Select-Object -First 1
  if ($null -ne $preferred) { $synth.SelectVoice($preferred.VoiceInfo.Name) }
  $voice=$synth.Voice.Name
} finally { $synth.Dispose() }
[Console]::Out.Write((@{
  recognizers=$recognizers;voices=$voices;recognizer=$recognizer;voice=$voice
}|ConvertTo-Json -Compress))
`

const RECOGNIZE_SCRIPT = String.raw`
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Speech
$listenSeconds=30
if ($args.Count -gt 0) {
  $parsedSeconds=0
  if ([int]::TryParse($args[0],[ref]$parsedSeconds)) {
    $listenSeconds=[Math]::Min(30,[Math]::Max(1,$parsedSeconds))
  }
}
$recognizer=New-Object System.Speech.Recognition.SpeechRecognitionEngine
try {
  # This engine is only the private, on-device wake gate. Constraining the grammar
  # prevents legacy Windows dictation guesses from deciding what the user asked.
  $wakeOnly=New-Object System.Speech.Recognition.GrammarBuilder
  $wakeOnly.Culture=$recognizer.RecognizerInfo.Culture
  $wakeOnly.Append('Athena')
  $recognizer.LoadGrammar((New-Object System.Speech.Recognition.Grammar -ArgumentList $wakeOnly))
  $wakeCommand=New-Object System.Speech.Recognition.GrammarBuilder
  $wakeCommand.Culture=$recognizer.RecognizerInfo.Culture
  $wakeCommand.Append('Athena')
  $wakeCommand.AppendDictation()
  $recognizer.LoadGrammar((New-Object System.Speech.Recognition.Grammar -ArgumentList $wakeCommand))
  $recognizer.SetInputToDefaultAudioDevice()
  $result=$recognizer.Recognize([TimeSpan]::FromSeconds($listenSeconds))
  if ($null -eq $result) { exit 2 }
  if ($null -eq $result.Audio) { exit 3 }
  $audio=New-Object IO.MemoryStream
  try {
    $result.Audio.WriteToWaveStream($audio)
    [Console]::Out.Write((@{
      text=$result.Text
      confidence=$result.Confidence
      wave=[Convert]::ToBase64String($audio.ToArray())
    }|ConvertTo-Json -Compress))
  } finally { $audio.Dispose() }
} finally { $recognizer.Dispose() }
`

const SPEAK_TEXT_SCRIPT = String.raw`
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Speech
$synth=New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $preferred=$synth.GetInstalledVoices() | Where-Object {
    $_.Enabled -and $_.VoiceInfo.Gender -eq [System.Speech.Synthesis.VoiceGender]::Female
  } | Select-Object -First 1
  if ($null -ne $preferred) { $synth.SelectVoice($preferred.VoiceInfo.Name) }
  $synth.Speak($args[0])
} finally { $synth.Dispose() }
`

const PLAY_WAVE_SCRIPT = String.raw`
$ErrorActionPreference='Stop'
$player=New-Object System.Media.SoundPlayer $args[0]
try { $player.PlaySync() } finally { $player.Dispose() }
`

export async function probeWindowsSpeech(
  runner: PowerShellRunner = runPowerShell,
  platform = process.platform,
): Promise<SpeechBackendProbe> {
  if (platform !== 'win32') {
    return {
      backend: 'unavailable',
      available: false,
      recognizers: 0,
      voices: 0,
      recognizer: null,
      voice: null,
      detail: 'The first voice backend supports Windows System.Speech only.',
    }
  }
  try {
    const raw = JSON.parse(await runner(PROBE_SCRIPT)) as {
      recognizers?: unknown
      voices?: unknown
      recognizer?: unknown
      voice?: unknown
    }
    const recognizers = Number(raw.recognizers ?? 0)
    const voices = Number(raw.voices ?? 0)
    const recognizer = typeof raw.recognizer === 'string' ? raw.recognizer.trim() || null : null
    const voice = typeof raw.voice === 'string' ? raw.voice.trim() || null : null
    const available = recognizers > 0 && voices > 0
    return {
      backend: available ? 'windows-system-speech' : 'unavailable',
      available,
      recognizers,
      voices,
      recognizer,
      voice,
      detail: available
        ? `${recognizers} local recognizer(s), ${voices} local voice(s); ` +
          `input: Windows default capture endpoint; recognizer: ${recognizer ?? 'unknown'}; ` +
          `prompt voice: ${voice ?? 'Windows default'}`
        : 'System.Speech loaded but no recognizer or voice is installed.',
    }
  } catch (error) {
    return {
      backend: 'unavailable',
      available: false,
      recognizers: 0,
      voices: 0,
      recognizer: null,
      voice: null,
      detail: (error as Error).message,
    }
  }
}

export async function recognizeWindowsPhrase(
  runner: PowerShellRunner = runPowerShell,
  listenSeconds = 30,
): Promise<RecognizedPhrase | null> {
  const boundedSeconds = Math.min(30, Math.max(1, Math.round(listenSeconds)))
  try {
    const raw = JSON.parse(await runner(
      RECOGNIZE_SCRIPT,
      [String(boundedSeconds)],
      boundedSeconds * 1_000 + 10_000,
    )) as {
      text?: unknown
      confidence?: unknown
      wave?: unknown
    }
    const text = typeof raw.text === 'string' ? raw.text.trim() : ''
    const wave = typeof raw.wave === 'string' ? Buffer.from(raw.wave, 'base64') : Buffer.alloc(0)
    if (!text || wave.length === 0) return null
    return {
      text,
      confidence: Number(raw.confidence ?? 0),
      audio: realtimePcmFromWave(wave),
    }
  } catch (error) {
    if ((error as { code?: unknown }).code === 2) return null
    throw error
  }
}

/** Convert the PCM WAV emitted by System.Speech into Realtime's required 24 kHz mono PCM. */
export function realtimePcmFromWave(wave: Buffer, targetRate = 24_000): Buffer {
  if (wave.length < 44 || wave.toString('ascii', 0, 4) !== 'RIFF' ||
      wave.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Windows wake detector returned malformed audio.')
  }
  let offset = 12
  let channels = 0
  let sampleRate = 0
  let bitsPerSample = 0
  let pcmFormat = 0
  let data: Buffer | null = null
  while (offset + 8 <= wave.length) {
    const id = wave.toString('ascii', offset, offset + 4)
    const size = wave.readUInt32LE(offset + 4)
    const start = offset + 8
    const end = start + size
    if (end > wave.length) throw new Error('Windows wake detector returned truncated audio.')
    if (id === 'fmt ' && size >= 16) {
      pcmFormat = wave.readUInt16LE(start)
      channels = wave.readUInt16LE(start + 2)
      sampleRate = wave.readUInt32LE(start + 4)
      bitsPerSample = wave.readUInt16LE(start + 14)
    } else if (id === 'data') {
      data = wave.subarray(start, end)
    }
    offset = end + (size % 2)
  }
  if (pcmFormat !== 1 || bitsPerSample !== 16 || ![1, 2].includes(channels) ||
      sampleRate <= 0 || !data || data.length < channels * 2) {
    throw new Error('Windows wake detector returned an unsupported audio format.')
  }
  const frameCount = Math.floor(data.length / (channels * 2))
  const mono = new Int16Array(frameCount)
  for (let frame = 0; frame < frameCount; frame++) {
    const left = data.readInt16LE(frame * channels * 2)
    const right = channels === 2 ? data.readInt16LE(frame * channels * 2 + 2) : left
    mono[frame] = Math.round((left + right) / 2)
  }
  const outputFrames = Math.max(1, Math.round(frameCount * targetRate / sampleRate))
  const output = Buffer.alloc(outputFrames * 2)
  for (let frame = 0; frame < outputFrames; frame++) {
    const source = frame * sampleRate / targetRate
    const before = Math.min(frameCount - 1, Math.floor(source))
    const after = Math.min(frameCount - 1, before + 1)
    const fraction = source - before
    const sample = Math.round(mono[before]! + (mono[after]! - mono[before]!) * fraction)
    output.writeInt16LE(Math.max(-32_768, Math.min(32_767, sample)), frame * 2)
  }
  return output
}

export function stripWakePhrase(text: string, wakePhrase = 'Athena'): string | null {
  const escaped = wakePhrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`^${escaped}(?:[,.!?;:]|\\s)+(.*)$`, 'i').exec(text.trim())
  const command = match?.[1]?.trim()
  return command ? command : null
}

export async function speakWindowsText(
  text: string,
  runner: PowerShellRunner = runPowerShell,
): Promise<void> {
  await runner(SPEAK_TEXT_SCRIPT, [text.slice(0, 4_096)])
}

function pcm16Wave(pcm: Buffer, sampleRate = 24_000): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

export async function playWindowsPcm(
  pcm: Buffer,
  runner: PowerShellRunner = runPowerShell,
): Promise<void> {
  if (pcm.length === 0) return
  const directory = await mkdtemp(join(tmpdir(), 'athena-voice-'))
  const waveFile = join(directory, 'response.wav')
  try {
    await writeFile(waveFile, pcm16Wave(pcm), { mode: 0o600 })
    await runner(PLAY_WAVE_SCRIPT, [waveFile])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
