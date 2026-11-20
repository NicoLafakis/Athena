import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { DuplexAudioTransport } from './live-stream-session.js'

/**
 * Single persistent Windows winmm.dll full-duplex 24 kHz mono PCM16LE audio engine:
 * - Captures continuous 60ms mic frames via waveInOpen (CALLBACK_EVENT worker thread)
 *   with perceptual dBFS metering and gentle speech gain for laptop mic arrays.
 * - Streams incoming assistant PCM chunks straight to waveOutWrite via stdin (`play <b64>`)
 *   with zero process-spawn latency and instant `flush` (waveOutReset) for barge-in.
 */
const WINDOWS_DUPLEX_AUDIO_SCRIPT = String.raw`
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Threading;

public static class AthenaWinMmDuplex
{
    private const int WAVE_MAPPER = -1;
    private const int WAVE_FORMAT_PCM = 1;
    private const int CALLBACK_NULL = 0x00000000;
    private const int CALLBACK_EVENT = 0x00050000;
    private const uint WHDR_DONE = 0x00000001;
    private const int IN_BUFFER_COUNT = 8;

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

    [DllImport("winmm.dll")]
    private static extern int waveOutOpen(out IntPtr phwo, int uDeviceID, ref WAVEFORMATEX pwfx, IntPtr dwCallback, IntPtr dwInstance, int fdwOpen);
    [DllImport("winmm.dll")]
    private static extern int waveOutPrepareHeader(IntPtr hwo, IntPtr pwh, int cbwh);
    [DllImport("winmm.dll")]
    private static extern int waveOutUnprepareHeader(IntPtr hwo, IntPtr pwh, int cbwh);
    [DllImport("winmm.dll")]
    private static extern int waveOutWrite(IntPtr hwo, IntPtr pwh, int cbwh);
    [DllImport("winmm.dll")]
    private static extern int waveOutReset(IntPtr hwo);
    [DllImport("winmm.dll")]
    private static extern int waveOutClose(IntPtr hwo);

    private struct OutChunk
    {
        public IntPtr HdrPtr;
        public IntPtr DataPtr;
    }

    private static volatile bool Stopping = false;

    private static void Emit(string json)
    {
        Console.Out.WriteLine(json);
        Console.Out.Flush();
    }

    private static void ReclaimDoneOutChunks(IntPtr hWaveOut, List<OutChunk> queue, int hdrSize)
    {
        for (int i = queue.Count - 1; i >= 0; i--)
        {
            var hdr = (WAVEHDR)Marshal.PtrToStructure(queue[i].HdrPtr, typeof(WAVEHDR));
            if ((hdr.dwFlags & WHDR_DONE) != 0)
            {
                try { waveOutUnprepareHeader(hWaveOut, queue[i].HdrPtr, hdrSize); } catch {}
                Marshal.FreeHGlobal(queue[i].HdrPtr);
                Marshal.FreeHGlobal(queue[i].DataPtr);
                queue.RemoveAt(i);
            }
        }
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

        int hdrSize = Marshal.SizeOf(typeof(WAVEHDR));
        IntPtr hWaveIn = IntPtr.Zero;
        IntPtr hWaveOut = IntPtr.Zero;
        IntPtr[] inHdrPtrs = new IntPtr[IN_BUFFER_COUNT];
        IntPtr[] inDataPtrs = new IntPtr[IN_BUFFER_COUNT];
        var outQueue = new List<OutChunk>();
        var dataEvent = new AutoResetEvent(false);

        int openIn = waveInOpen(
            out hWaveIn,
            WAVE_MAPPER,
            ref fmt,
            dataEvent.SafeWaitHandle.DangerousGetHandle(),
            IntPtr.Zero,
            CALLBACK_EVENT
        );
        if (openIn != 0) throw new InvalidOperationException("waveInOpen failed with code " + openIn);

        int openOut = waveOutOpen(out hWaveOut, WAVE_MAPPER, ref fmt, IntPtr.Zero, IntPtr.Zero, CALLBACK_NULL);
        if (openOut != 0)
        {
            waveInClose(hWaveIn);
            throw new InvalidOperationException("waveOutOpen failed with code " + openOut);
        }

        Thread worker = null;
        try
        {
            for (int i = 0; i < IN_BUFFER_COUNT; i++)
            {
                inDataPtrs[i] = Marshal.AllocHGlobal(bytesPerFrame);
                inHdrPtrs[i] = Marshal.AllocHGlobal(hdrSize);
                var hdr = new WAVEHDR
                {
                    lpData = inDataPtrs[i],
                    dwBufferLength = (uint)bytesPerFrame
                };
                Marshal.StructureToPtr(hdr, inHdrPtrs[i], false);
                waveInPrepareHeader(hWaveIn, inHdrPtrs[i], hdrSize);
                waveInAddBuffer(hWaveIn, inHdrPtrs[i], hdrSize);
            }

            worker = new Thread(() =>
            {
                byte[] pcm = new byte[bytesPerFrame];
                byte[] boosted = new byte[bytesPerFrame];
                while (!Stopping)
                {
                    dataEvent.WaitOne(100);
                    if (Stopping) break;
                    for (int i = 0; i < IN_BUFFER_COUNT; i++)
                    {
                        var hdr = (WAVEHDR)Marshal.PtrToStructure(inHdrPtrs[i], typeof(WAVEHDR));
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
                            int level = (int)Math.Max(0, Math.Min(100, Math.Round((dbfs + 58.0) / 44.0 * 100.0)));
                            // Gentle 3x speech boost for quiet laptop mic arrays without amplifying silence
                            double gain = dbfs > -48.0 ? 3.0 : 1.0;
                            if (gain > 1.0)
                            {
                                for (int sIdx = 0; sIdx < samples; sIdx++)
                                {
                                    short s = (short)(pcm[sIdx * 2] | (pcm[sIdx * 2 + 1] << 8));
                                    int v = (int)Math.Round(s * gain);
                                    if (v > 32767) v = 32767;
                                    else if (v < -32768) v = -32768;
                                    boosted[sIdx * 2] = (byte)(v & 0xFF);
                                    boosted[sIdx * 2 + 1] = (byte)((v >> 8) & 0xFF);
                                }
                                Emit("{\"level\":" + level.ToString(CultureInfo.InvariantCulture)
                                    + ",\"pcm\":\"" + Convert.ToBase64String(boosted, 0, len) + "\"}");
                            }
                            else
                            {
                                Emit("{\"level\":" + level.ToString(CultureInfo.InvariantCulture)
                                    + ",\"pcm\":\"" + Convert.ToBase64String(pcm, 0, len) + "\"}");
                            }
                        }
                        if (!Stopping) waveInAddBuffer(hWaveIn, inHdrPtrs[i], hdrSize);
                    }
                }
            });
            worker.IsBackground = true;
            worker.Start();

            int startRes = waveInStart(hWaveIn);
            if (startRes != 0) throw new InvalidOperationException("waveInStart failed with code " + startRes);

            Emit("{\"ready\":true,\"backend\":\"winmm-24khz-duplex\"}");

            while (true)
            {
                string line = Console.In.ReadLine();
                if (line == null) break;
                string trimmed = line.Trim();
                if (trimmed == "exit") break;
                if (trimmed == "flush")
                {
                    try { waveOutReset(hWaveOut); } catch {}
                    ReclaimDoneOutChunks(hWaveOut, outQueue, hdrSize);
                    continue;
                }
                if (trimmed.StartsWith("play "))
                {
                    ReclaimDoneOutChunks(hWaveOut, outQueue, hdrSize);
                    byte[] audio = Convert.FromBase64String(trimmed.Substring(5));
                    if (audio.Length < 2) continue;
                    IntPtr dataPtr = Marshal.AllocHGlobal(audio.Length);
                    Marshal.Copy(audio, 0, dataPtr, audio.Length);
                    IntPtr hdrPtr = Marshal.AllocHGlobal(hdrSize);
                    var hdr = new WAVEHDR
                    {
                        lpData = dataPtr,
                        dwBufferLength = (uint)audio.Length
                    };
                    Marshal.StructureToPtr(hdr, hdrPtr, false);
                    if (waveOutPrepareHeader(hWaveOut, hdrPtr, hdrSize) == 0 &&
                        waveOutWrite(hWaveOut, hdrPtr, hdrSize) == 0)
                    {
                        outQueue.Add(new OutChunk { HdrPtr = hdrPtr, DataPtr = dataPtr });
                    }
                    else
                    {
                        Marshal.FreeHGlobal(hdrPtr);
                        Marshal.FreeHGlobal(dataPtr);
                    }
                }
            }
        }
        finally
        {
            Stopping = true;
            try { dataEvent.Set(); } catch {}
            try { if (worker != null) worker.Join(500); } catch {}
            try { waveInStop(hWaveIn); } catch {}
            try { waveInReset(hWaveIn); } catch {}
            for (int i = 0; i < IN_BUFFER_COUNT; i++)
            {
                if (inHdrPtrs[i] != IntPtr.Zero)
                {
                    try { waveInUnprepareHeader(hWaveIn, inHdrPtrs[i], hdrSize); } catch {}
                    Marshal.FreeHGlobal(inHdrPtrs[i]);
                }
                if (inDataPtrs[i] != IntPtr.Zero) Marshal.FreeHGlobal(inDataPtrs[i]);
            }
            try { waveInClose(hWaveIn); } catch {}
            try { waveOutReset(hWaveOut); } catch {}
            for (int i = 0; i < outQueue.Count; i++)
            {
                try { waveOutUnprepareHeader(hWaveOut, outQueue[i].HdrPtr, hdrSize); } catch {}
                Marshal.FreeHGlobal(outQueue[i].HdrPtr);
                Marshal.FreeHGlobal(outQueue[i].DataPtr);
            }
            outQueue.Clear();
            try { waveOutClose(hWaveOut); } catch {}
            try { dataEvent.Dispose(); } catch {}
        }
    }
}
'@
[AthenaWinMmDuplex]::Run(24000, 60)
`

function resolvePowerShell(): string {
  const winPs = process.env['SystemRoot']
    ? `${process.env['SystemRoot']}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    : null
  if (winPs && existsSync(winPs)) return winPs
  return 'powershell.exe'
}

export class WindowsDuplexAudio implements DuplexAudioTransport {
  private child: ChildProcess | null = null
  private lineBuffer = ''
  private closed = false

  start(handlers: {
    onReady: (backend: string) => void
    onFrame: (pcm: Buffer, level: number) => void
    onWarn: (message: string) => void
  }): void {
    if (this.child || this.closed) return
    const child = spawn(
      resolvePowerShell(),
      ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_DUPLEX_AUDIO_SCRIPT],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    )
    this.child = child
    let stderrTail = ''
    child.stdout?.on('data', (chunk: Buffer | string) => {
      this.lineBuffer += chunk.toString('utf8')
      const lines = this.lineBuffer.split(/\r?\n/)
      this.lineBuffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        let parsed: Record<string, unknown>
        try {
          parsed = JSON.parse(trimmed) as Record<string, unknown>
        } catch {
          continue
        }
        if (parsed['ready'] === true) {
          handlers.onReady(typeof parsed['backend'] === 'string' ? parsed['backend'] : 'winmm-24khz-duplex')
          continue
        }
        if (typeof parsed['level'] === 'number' && typeof parsed['pcm'] === 'string') {
          const level = Math.max(0, Math.min(100, Math.round(parsed['level'])))
          handlers.onFrame(Buffer.from(parsed['pcm'], 'base64'), level)
        }
      }
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-512)
    })
    child.once('exit', (code) => {
      if (this.closed) return
      handlers.onWarn(
        `Windows full-duplex audio exited (code ${code ?? 'unknown'}): ${stderrTail.trim() || 'no stderr'}`,
      )
    })
  }

  playChunk(pcm: Buffer): void {
    if (this.closed || !this.child?.stdin || pcm.length < 2) return
    try {
      this.child.stdin.write(`play ${pcm.toString('base64')}\n`)
    } catch {
      // ignore closed pipe
    }
  }

  flushPlayback(): void {
    if (this.closed || !this.child?.stdin) return
    try {
      this.child.stdin.write('flush\n')
    } catch {
      // ignore closed pipe
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
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
}
