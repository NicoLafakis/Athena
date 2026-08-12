import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const POWERSHELL_TIMEOUT_MS = 45_000

function encodedPowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

const ARGUMENT_PRELUDE = String.raw`
$athenaVoiceArgsJson=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:ATHENA_VOICE_PS_ARGS))
$args=[string[]]($athenaVoiceArgsJson|ConvertFrom-Json)
`

function powerShellInvocation(script: string, args: readonly string[]): {
  command: string
  commandArgs: string[]
  env: NodeJS.ProcessEnv
} {
  return {
    command: 'powershell.exe',
    commandArgs: [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      encodedPowerShell(`${ARGUMENT_PRELUDE}\n${script}`),
    ],
    env: {
      ...process.env,
      ATHENA_VOICE_PS_ARGS: Buffer.from(JSON.stringify(args), 'utf8').toString('base64'),
    },
  }
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
    const invocation = powerShellInvocation(script, args)
    execFile(
      invocation.command,
      invocation.commandArgs,
      {
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        env: invocation.env,
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

/**
 * Spawn the long-lived wake listener process (streaming stdout, open stdin).
 * Shares the encoded-command transport with `runPowerShell`; the caller owns the
 * child's lifecycle (read JSONL from stdout, write `exit` and/or kill to stop).
 * `wavePath` feeds the recognizer a WAV file instead of the microphone — the
 * sentinel seam the real-subprocess test uses to prove the continuous pipeline.
 */
export function spawnWindowsWakeListener(wavePath?: string): ChildProcess {
  const invocation = powerShellInvocation(PERSISTENT_LISTEN_SCRIPT, wavePath ? [wavePath] : [])
  return spawn(invocation.command, invocation.commandArgs, {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: invocation.env,
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

const PERSISTENT_LISTEN_SCRIPT = String.raw`
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Speech
# The phrase sink is compiled C#: it runs natively on the recognizer's raising thread.
# A scriptblock event delegate never fires reliably while the main thread blocks on
# stdin (and can tear the process down when it does), and Register-ObjectEvent depends
# on module autoload that can stall for tens of seconds under process churn.
Add-Type -TypeDefinition @'
using System;
using System.Globalization;
using System.IO;
using System.Speech.Recognition;

public static class AthenaWakeSink
{
    public static void Recognized(object sender, SpeechRecognizedEventArgs e)
    {
        try
        {
            var result = e.Result;
            if (result == null || result.Audio == null) return;
            using (var ms = new MemoryStream())
            {
                result.Audio.WriteToWaveStream(ms);
                Console.Out.WriteLine("{\"text\":" + Quote(result.Text)
                    + ",\"confidence\":" + result.Confidence.ToString("R", CultureInfo.InvariantCulture)
                    + ",\"wave\":\"" + Convert.ToBase64String(ms.ToArray()) + "\"}");
                Console.Out.Flush();
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(ex.Message);
            Console.Error.Flush();
        }
    }

    private static string Quote(string value)
    {
        var builder = new System.Text.StringBuilder("\"");
        foreach (var c in value)
        {
            switch (c)
            {
                case '\"': builder.Append("\\\""); break;
                case '\\': builder.Append("\\\\"); break;
                case '\b': builder.Append("\\b"); break;
                case '\f': builder.Append("\\f"); break;
                case '\n': builder.Append("\\n"); break;
                case '\r': builder.Append("\\r"); break;
                case '\t': builder.Append("\\t"); break;
                default:
                    if (c < ' ') builder.Append("\\u" + ((int)c).ToString("x4"));
                    else builder.Append(c);
                    break;
            }
        }
        builder.Append("\"");
        return builder.ToString();
    }
}
'@ -ReferencedAssemblies 'System.Speech'
$recognizer=New-Object System.Speech.Recognition.SpeechRecognitionEngine
try {
  # Grammars: 'Athena' + dictation carries a fluid wake-and-command phrase; free
  # dictation carries the command that follows a bare wake word. The Node side owns
  # the wake/listen state machine — pre-wake audio still never leaves the machine.
  $wakeCommand=New-Object System.Speech.Recognition.GrammarBuilder
  $wakeCommand.Culture=$recognizer.RecognizerInfo.Culture
  $wakeCommand.Append('Athena')
  $wakeCommand.AppendDictation()
  $recognizer.LoadGrammar((New-Object System.Speech.Recognition.Grammar -ArgumentList $wakeCommand))
  $freeDictation=New-Object System.Speech.Recognition.GrammarBuilder
  $freeDictation.Culture=$recognizer.RecognizerInfo.Culture
  $freeDictation.AppendDictation()
  $recognizer.LoadGrammar((New-Object System.Speech.Recognition.Grammar -ArgumentList $freeDictation))
  # Optional sentinel input: a WAV file exercises the identical continuous pipeline in
  # tests without a microphone. Production passes no argument and opens the real device.
  if ($args.Count -gt 0 -and $args[0]) {
    $stream=[IO.File]::OpenRead($args[0])
    $recognizer.SetInputToWaveStream($stream)
  } else {
    $recognizer.SetInputToDefaultAudioDevice()
  }
  # Readiness is a real open of the capture input, never a platform guess.
  [Console]::Out.WriteLine((@{
    ready=$true;recognizer=$recognizer.RecognizerInfo.Description
  }|ConvertTo-Json -Compress))
  [Console]::Out.Flush()
  $handlerType=[System.EventHandler[System.Speech.Recognition.SpeechRecognizedEventArgs]]
  $handler=[Delegate]::CreateDelegate($handlerType, [AthenaWakeSink].GetMethod('Recognized'))
  $recognizer.add_SpeechRecognized($handler)
  # One continuous recognition: the microphone opens once and stays open while the
  # parent voice session is alive. stdin EOF (parent exit) or an 'exit' line stops it.
  $recognizer.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple)
  while ($true) {
    $line=[Console]::In.ReadLine()
    if ($null -eq $line -or $line.Trim() -eq 'exit') { break }
  }
} finally {
  try { $recognizer.RecognizeAsyncStop() } catch {}
  $recognizer.Dispose()
  if ($null -ne $stream) { try { $stream.Dispose() } catch {} }
}
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

/**
 * Synthesize a short cue tone sequence as 24 kHz mono PCM (the same format
 * playWindowsPcm wraps). Soft amplitude and 5 ms edge fades keep it click-free.
 */
export function cueTonePcm(
  frequencies: readonly number[],
  toneMs = 90,
  sampleRate = 24_000,
): Buffer {
  const amplitude = 0.22
  const fadeFrames = Math.floor(sampleRate * 0.005)
  const framesPerTone = Math.floor(sampleRate * toneMs / 1_000)
  const gapFrames = Math.floor(sampleRate * 0.03)
  const totalFrames = frequencies.length * framesPerTone + (frequencies.length - 1) * gapFrames
  const pcm = Buffer.alloc(totalFrames * 2)
  let frame = 0
  frequencies.forEach((frequency, index) => {
    for (let i = 0; i < framesPerTone; i++) {
      const edge = Math.min(1, i / fadeFrames, (framesPerTone - 1 - i) / fadeFrames)
      const sample = Math.sin(2 * Math.PI * frequency * i / sampleRate) * amplitude * Math.max(0, edge)
      pcm.writeInt16LE(Math.round(sample * 32_767), frame * 2)
      frame++
    }
    if (index < frequencies.length - 1) frame += gapFrames
  })
  return pcm
}

/** Rising pair: the wake word landed and Athena is capturing the command. */
export async function playListeningCue(runner: PowerShellRunner = runPowerShell): Promise<void> {
  await playWindowsPcm(cueTonePcm([880, 1_320]), runner)
}

/** Falling pair: Marin finished speaking; Athena is back at wake standby. */
export async function playStandbyCue(runner: PowerShellRunner = runPowerShell): Promise<void> {
  await playWindowsPcm(cueTonePcm([660, 440], 70), runner)
}
