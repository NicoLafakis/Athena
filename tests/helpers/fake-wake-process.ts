import { EventEmitter } from 'node:events'
import type { WakeListenerProcess } from '../../src/voice/daemon.js'

/** A minimal 16 kHz mono WAV, the framing the real listener emits phrase audio in. */
export function pcmWave(sampleRate = 16_000, samples = [0, 1, -1, 2]): Buffer {
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

/** One JSONL phrase event, as the compiled C# sink writes it. */
export function phraseLine(text: string, confidence: number): string {
  return JSON.stringify({ text, confidence, wave: pcmWave().toString('base64') })
}

/** The readiness round trip the listener must prove before any phrase is believed. */
export function readyLine(recognizer = 'Athena Test Recognizer'): string {
  return `${JSON.stringify({ ready: true, recognizer })}\n`
}

/** The streaming subset of the real wake subprocess, driven line by line from a test. */
export class FakeWakeProcess implements WakeListenerProcess {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly written: string[] = []
  ended = false
  killed = false
  private readonly exitEmitter = new EventEmitter()
  readonly stdin = {
    write: (chunk: string) => {
      this.written.push(chunk)
      return true
    },
    end: () => {
      this.ended = true
    },
  }

  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this {
    this.exitEmitter.once(event, listener)
    return this
  }

  kill(): boolean {
    this.killed = true
    this.emitExit(null, 'SIGTERM')
    return true
  }

  emitExit(code: number | null = 1, signal: NodeJS.Signals | null = null): void {
    this.exitEmitter.emit('exit', code, signal)
  }

  emitStdout(text: string): void {
    this.stdout.emit('data', Buffer.from(text))
  }
}

export function fakeSpawner(processes: FakeWakeProcess[]): () => FakeWakeProcess {
  return () => {
    const listener = new FakeWakeProcess()
    processes.push(listener)
    return listener
  }
}
