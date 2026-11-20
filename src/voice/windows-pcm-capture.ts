import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { VoiceCommand, VoiceCommandInput } from './daemon.js'

export interface PcmVadSegmenterOptions {
  /** RMS 0..100 level threshold to trigger speech onset (default 10). */
  speechThreshold?: number
  /** Silence duration in ms after speech before flushing the utterance (default 850). */
  silenceTailMs?: number
  /** Minimum active speech duration in ms to ignore clicks/coughs (default 240). */
  minSpeechMs?: number
  /** Maximum utterance duration in ms before auto-flushing (default 25_000). */
  maxUtteranceMs?: number
  /** Number of 60ms pre-roll frames kept so the first syllable is never clipped (default 5 = 300ms). */
  preRollFrames?: number
  /** Duration per incoming PCM frame in ms (default 60). */
  frameMs?: number
  onSpeechStart?: () => void
  onUtterance: (pcm: Buffer) => void
}

/**
 * Pure, deterministic RMS energy + silence-tail VAD over 24 kHz mono PCM16LE frames.
 * Keeps a pre-roll ring buffer so the start of speech is never clipped, ignores short
 * clicks below `minSpeechMs`, and drops all frames while muted during assistant playback.
 */
export class PcmVadSegmenter {
  private readonly speechThreshold: number
  private readonly silenceTailFrames: number
  private readonly minSpeechFrames: number
  private readonly maxUtteranceFrames: number
  private readonly preRollFrames: number
  private readonly onSpeechStart: () => void
  private readonly onUtterance: (pcm: Buffer) => void

  private muted = false
  private inSpeech = false
  private activeSpeechFrames = 0
  private trailingSilenceFrames = 0
  private preRoll: Buffer[] = []
  private buffer: Buffer[] = []

  constructor(options: PcmVadSegmenterOptions) {
    const frameMs = Math.max(10, options.frameMs ?? 60)
    this.speechThreshold = options.speechThreshold ?? 10
    this.silenceTailFrames = Math.max(1, Math.round((options.silenceTailMs ?? 850) / frameMs))
    this.minSpeechFrames = Math.max(1, Math.round((options.minSpeechMs ?? 240) / frameMs))
    this.maxUtteranceFrames = Math.max(10, Math.round((options.maxUtteranceMs ?? 25_000) / frameMs))
    this.preRollFrames = Math.max(0, options.preRollFrames ?? 5)
    this.onSpeechStart = options.onSpeechStart ?? (() => {})
    this.onUtterance = options.onUtterance
  }

  setMuted(muted: boolean): void {
    this.muted = muted
    if (muted) this.reset()
  }

  reset(): void {
    this.inSpeech = false
    this.activeSpeechFrames = 0
    this.trailingSilenceFrames = 0
    this.preRoll = []
    this.buffer = []
  }

  pushFrame(pcm: Buffer, level: number): void {
    if (this.muted || pcm.length === 0) return
    const isVoice = level >= this.speechThreshold

    if (!this.inSpeech) {
      if (isVoice) {
        this.inSpeech = true
        this.activeSpeechFrames = 1
        this.trailingSilenceFrames = 0
        this.buffer = [...this.preRoll, pcm]
        this.preRoll = []
        this.onSpeechStart()
      } else if (this.preRollFrames > 0) {
        this.preRoll.push(pcm)
        if (this.preRoll.length > this.preRollFrames) this.preRoll.shift()
      }
      return
    }

    this.buffer.push(pcm)
    if (isVoice) {
      this.activeSpeechFrames++
      this.trailingSilenceFrames = 0
    } else {
      this.trailingSilenceFrames++
    }

    if (
      this.trailingSilenceFrames >= this.silenceTailFrames ||
      this.buffer.length >= this.maxUtteranceFrames
    ) {
      const shouldEmit = this.activeSpeechFrames >= this.minSpeechFrames
      const payload = shouldEmit ? Buffer.concat(this.buffer) : null
      this.reset()
      if (payload) this.onUtterance(payload)
    }
  }
}

/**
 * Softly normalizes quiet laptop microphone array PCM16LE utterances up to a comfortable
 * speech level (~-6 dBFS peak, capped at 8x gain) so OpenAI receives clear audio without
 * amplifying near-silence into static.
 */
export function normalizePcmForSpeech(pcm: Buffer): Buffer {
  if (pcm.length < 2) return pcm
  let peak = 0
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const abs = Math.abs(pcm.readInt16LE(i))
    if (abs > peak) peak = abs
  }
  // Ignore near-silence (< ~-44 dBFS) or already-strong signals (>= ~-10 dBFS)
  if (peak < 200 || peak >= 10_000) return pcm
  const targetPeak = 16_384 // -6 dBFS
  const gain = Math.min(8, targetPeak / peak)
  if (gain <= 1.1) return pcm
  const out = Buffer.allocUnsafe(pcm.length)
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const scaled = Math.round(pcm.readInt16LE(i) * gain)
    out.writeInt16LE(Math.max(-32_768, Math.min(32_767, scaled)), i)
  }
  return out
}

/**
 * Native Windows winmm.dll (waveInOpen/waveInAddBuffer) 24 kHz 16-bit mono PCM capture.
 * Uses CALLBACK_EVENT + a dedicated worker thread (never calling waveInAddBuffer inside
 * waveInProc, which Microsoft documents as a deadlock/glitch hazard). Emits 60ms JSONL
 * frames with raw base64 PCM and perceptual dBFS 0..100 level for live visualizers.
 */
const WINDOWS_DIRECT_PCM_SCRIPT = String.raw`
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Threading;

public static class AthenaWinMmCapture
{
    private const int WAVE_MAPPER = -1;
    private const int WAVE_FORMAT_PCM = 1;
    private const int CALLBACK_EVENT = 0x00050000;
    private const uint WHDR_DONE = 0x00000001;
    private const int BUFFER_COUNT = 8;

    [StructLayout(LayoutKind.Sequential)]
    private struct WAVEFORMATEX
    {
        public ushort wFormatTag;
        public ushort nChannels;
        public uint nSamplesPerSec;
        public uint nAvgBytesPerSec;
        public ushort nBlockAlign;
        public ushort wBitsPerSample;
        public ushort cbSize;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct WAVEHDR
    {
        public IntPtr lpData;
        public uint dwBufferLength;
        public uint dwBytesRecorded;
        public IntPtr dwUser;
        public uint dwFlags;
        public uint dwLoops;
        public IntPtr lpNext;
        public IntPtr reserved;
    }

    [DllImport("winmm.dll")]
    private static extern int waveInOpen(out IntPtr phwi, int uDeviceID, ref WAVEFORMATEX pwfx, IntPtr dwCallback, IntPtr dwInstance, int fdwOpen);
    [DllImport("winmm.dll")]
    private static extern int waveInPrepareHeader(IntPtr hwi, IntPtr pwh, int cbwh);
    [DllImport("winmm.dll")]
    private static extern int waveInUnprepareHeader(IntPtr hwi, IntPtr pwh, int cbwh);
    [DllImport("winmm.dll")]
    private static extern int waveInAddBuffer(IntPtr hwi, IntPtr pwh, int cbwh);
    [DllImport("winmm.dll")]
    private static extern int waveInStart(IntPtr hwi);
    [DllImport("winmm.dll")]
    private static extern int waveInStop(IntPtr hwi);
    [DllImport("winmm.dll")]
    private static extern int waveInReset(IntPtr hwi);
    [DllImport("winmm.dll")]
    private static extern int waveInClose(IntPtr hwi);

    private static volatile bool Stopping = false;

    private static void Emit(string json)
    {
        Console.Out.WriteLine(json);
        Console.Out.Flush();
    }

    public static void Run(int sampleRate, int frameMs)
    {
        int bytesPerFrame = (sampleRate * frameMs / 1000) * 2;
        var fmt = new WAVEFORMATEX
        {
            wFormatTag = WAVE_FORMAT_PCM,
            nChannels = 1,
            nSamplesPerSec = (uint)sampleRate,
            wBitsPerSample = 16,
            nBlockAlign = 2,
            nAvgBytesPerSec = (uint)(sampleRate * 2),
            cbSize = 0
        };

        IntPtr hWaveIn = IntPtr.Zero;
        IntPtr[] hdrPtrs = new IntPtr[BUFFER_COUNT];
        IntPtr[] dataPtrs = new IntPtr[BUFFER_COUNT];
        int hdrSize = Marshal.SizeOf(typeof(WAVEHDR));
        var dataEvent = new AutoResetEvent(false);

        int openRes = waveInOpen(
            out hWaveIn,
            WAVE_MAPPER,
            ref fmt,
            dataEvent.SafeWaitHandle.DangerousGetHandle(),
            IntPtr.Zero,
            CALLBACK_EVENT
        );
        if (openRes != 0) throw new InvalidOperationException("waveInOpen failed with code " + openRes);

        Thread worker = null;
        try
        {
            for (int i = 0; i < BUFFER_COUNT; i++)
            {
                dataPtrs[i] = Marshal.AllocHGlobal(bytesPerFrame);
                hdrPtrs[i] = Marshal.AllocHGlobal(hdrSize);
                var hdr = new WAVEHDR
                {
                    lpData = dataPtrs[i],
                    dwBufferLength = (uint)bytesPerFrame
                };
                Marshal.StructureToPtr(hdr, hdrPtrs[i], false);
                waveInPrepareHeader(hWaveIn, hdrPtrs[i], hdrSize);
                waveInAddBuffer(hWaveIn, hdrPtrs[i], hdrSize);
            }

            worker = new Thread(() =>
            {
                byte[] pcm = new byte[bytesPerFrame];
                while (!Stopping)
                {
                    dataEvent.WaitOne(100);
                    if (Stopping) break;
                    for (int i = 0; i < BUFFER_COUNT; i++)
                    {
                        var hdr = (WAVEHDR)Marshal.PtrToStructure(hdrPtrs[i], typeof(WAVEHDR));
                        if ((hdr.dwFlags & WHDR_DONE) == 0) continue;
                        int len = (int)hdr.dwBytesRecorded;
                        if (len >= 2 && len <= pcm.Length)
                        {
                            Marshal.Copy(hdr.lpData, pcm, 0, len);
                            double sumSq = 0;
                            int samples = len / 2;
                            for (int sIdx = 0; sIdx < samples; sIdx++)
                            {
                                short s = (short)(pcm[sIdx * 2] | (pcm[sIdx * 2 + 1] << 8));
                                double norm = s / 32768.0;
                                sumSq += norm * norm;
                            }
                            double rms = Math.Sqrt(sumSq / samples);
                            double dbfs = rms > 1e-6 ? 20.0 * Math.Log10(rms) : -96.0;
                            // Map -58 dBFS -> 0%, -14 dBFS -> 100% (matches speech AGC meter feel)
                            int level = (int)Math.Max(0, Math.Min(100, Math.Round((dbfs + 58.0) / 44.0 * 100.0)));
                            Emit("{\"level\":" + level.ToString(CultureInfo.InvariantCulture)
                                + ",\"pcm\":\"" + Convert.ToBase64String(pcm, 0, len) + "\"}");
                        }
                        if (!Stopping) waveInAddBuffer(hWaveIn, hdrPtrs[i], hdrSize);
                    }
                }
            });
            worker.IsBackground = true;
            worker.Start();

            int startRes = waveInStart(hWaveIn);
            if (startRes != 0) throw new InvalidOperationException("waveInStart failed with code " + startRes);

            Emit("{\"ready\":true,\"backend\":\"winmm-24khz-pcm\"}");

            while (true)
            {
                string line = Console.In.ReadLine();
                if (line == null || line.Trim() == "exit") break;
            }
        }
        finally
        {
            Stopping = true;
            try { dataEvent.Set(); } catch {}
            try { if (worker != null) worker.Join(500); } catch {}
            try { waveInStop(hWaveIn); } catch {}
            try { waveInReset(hWaveIn); } catch {}
            for (int i = 0; i < BUFFER_COUNT; i++)
            {
                if (hdrPtrs[i] != IntPtr.Zero)
                {
                    try { waveInUnprepareHeader(hWaveIn, hdrPtrs[i], hdrSize); } catch {}
                    Marshal.FreeHGlobal(hdrPtrs[i]);
                }
                if (dataPtrs[i] != IntPtr.Zero) Marshal.FreeHGlobal(dataPtrs[i]);
            }
            try { waveInClose(hWaveIn); } catch {}
            try { dataEvent.Dispose(); } catch {}
        }
    }
}
'@
[AthenaWinMmCapture]::Run(24000, 60)
`

function resolvePowerShell(): string {
  const winPs = process.env['SystemRoot']
    ? `${process.env['SystemRoot']}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    : null
  if (winPs && existsSync(winPs)) return winPs
  return 'powershell.exe'
}

export interface WindowsDirectPcmInputOptions {
  speechThreshold?: number
  silenceTailMs?: number
  minSpeechMs?: number
  onReady?: (backend: string) => void
  onAudioLevel?: (level: number) => void
  onSpeechStart?: () => void
  onUtteranceCaptured?: () => void
  onWarn?: (message: string) => void
}

/**
 * Direct 24 kHz PCM microphone capture for open-conversation voice mode.
 * Bypasses legacy Windows System.Speech dictation completely so OpenAI's own
 * audio/transcription model hears the full unclipped utterance.
 */
export class WindowsDirectPcmInput implements VoiceCommandInput {
  private readonly vad: PcmVadSegmenter
  private readonly onReady: (backend: string) => void
  private readonly onAudioLevel: (level: number) => void
  private readonly onWarn: (message: string) => void

  private child: ChildProcess | null = null
  private lineBuffer = ''
  private queue: VoiceCommand[] = []
  private waiters: Array<{ resolve: (cmd: VoiceCommand) => void; reject: (err: Error) => void }> = []
  private closed = false
  private failed: Error | null = null
  private muted = false

  constructor(options: WindowsDirectPcmInputOptions = {}) {
    this.onReady = options.onReady ?? (() => {})
    this.onAudioLevel = options.onAudioLevel ?? (() => {})
    this.onWarn = options.onWarn ?? (() => {})
    const onUtteranceCaptured = options.onUtteranceCaptured ?? (() => {})
    this.vad = new PcmVadSegmenter({
      speechThreshold: options.speechThreshold ?? 18,
      silenceTailMs: options.silenceTailMs ?? 850,
      minSpeechMs: options.minSpeechMs ?? 240,
      onSpeechStart: options.onSpeechStart,
      onUtterance: (pcm) => {
        onUtteranceCaptured()
        this.deliver({ kind: 'audio', pcm: normalizePcmForSpeech(pcm) })
      },
    })
  }

  setMuted(muted: boolean): void {
    this.muted = muted
    this.vad.setMuted(muted)
  }

  async next(): Promise<VoiceCommand | null> {
    const queued = this.queue.shift()
    if (queued) return queued
    if (this.failed) throw this.failed
    if (this.closed) throw new Error('Athena direct PCM capture is closed.')
    this.ensureStarted()
    return new Promise<VoiceCommand>((resolve, reject) => {
      this.waiters.push({ resolve, reject })
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    const err = new Error('Athena direct PCM capture is closed.')
    for (const waiter of this.waiters.splice(0)) waiter.reject(err)
    const child = this.child
    this.child = null
    if (!child) return
    try {
      child.stdin?.write('exit\n')
      child.stdin?.end()
    } catch {
      // ignore
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* already exited */ }
    }, 1_000)
    timer.unref?.()
    child.once('exit', () => clearTimeout(timer))
  }

  private ensureStarted(): void {
    if (this.child || this.closed) return
    const child = spawn(
      resolvePowerShell(),
      ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_DIRECT_PCM_SCRIPT],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    )
    this.child = child
    let stderrTail = ''
    child.stdout?.on('data', (chunk: Buffer | string) => {
      this.lineBuffer += chunk.toString('utf8')
      const lines = this.lineBuffer.split(/\r?\n/)
      this.lineBuffer = lines.pop() ?? ''
      for (const line of lines) this.handleLine(line)
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-512)
    })
    child.once('exit', (code) => {
      if (this.closed) return
      const err = new Error(
        `Windows direct PCM capture exited (code ${code ?? 'unknown'}): ${stderrTail.trim() || 'no stderr'}`,
      )
      this.failed = err
      this.onWarn(err.message)
      for (const waiter of this.waiters.splice(0)) waiter.reject(err)
    })
  }

  private handleLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      return
    }
    if (parsed['ready'] === true) {
      this.onReady(typeof parsed['backend'] === 'string' ? parsed['backend'] : 'winmm-24khz-pcm')
      return
    }
    if (typeof parsed['level'] === 'number' && typeof parsed['pcm'] === 'string') {
      if (this.muted) return
      const level = Math.max(0, Math.min(100, Math.round(parsed['level'])))
      this.onAudioLevel(level)
      const pcm = Buffer.from(parsed['pcm'], 'base64')
      this.vad.pushFrame(pcm, level)
    }
  }

  private deliver(command: VoiceCommand): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter.resolve(command)
    else {
      this.queue.push(command)
      if (this.queue.length > 4) this.queue.shift()
    }
  }
}
