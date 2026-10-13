import { createInterface, type Interface } from 'node:readline/promises'

export interface LineInput {
  readLine(prompt: string): Promise<string>
  readConsent?(prompt: string): Promise<string>
  cancelRead?(): boolean
  close(): void
}

export class LineInputCancelledError extends Error {
  constructor() {
    super('Line input canceled.')
    this.name = 'LineInputCancelledError'
  }
}

/** Native line input with terminal editing disabled. The presentation layer serializes
 * calls, so announcements never rewrite an active prompt. */
export class ReadlineLineInput implements LineInput {
  private readonly readline: Interface
  private readonly queued: string[] = []
  private pending: { resolve: (value: string) => void; reject: (error: Error) => void } | null = null
  private closed = false
  private partialLine = false
  private discardPartial = false
  private discardChunk = false

  constructor(
    input: NodeJS.ReadableStream = process.stdin,
    private readonly output: NodeJS.WritableStream = process.stdout,
  ) {
    // Observe raw data before readline's listener: complete-line buffering alone
    // cannot distinguish a fresh answer from an old draft finished after consent
    // opens. Quarantine the entire completing chunk, including pasted extra lines.
    const trackChunk = (chunk: Buffer | string): void => {
      const text = String(chunk)
      if (!text) return
      this.discardChunk = this.discardPartial
      this.partialLine = !/[\r\n]$/.test(text)
      if (this.discardChunk) this.discardPartial = this.partialLine
    }
    input.on('data', trackChunk)
    this.readline = createInterface({ input, output, terminal: false })
    this.readline.on('line', (line) => {
      if (this.discardChunk) return
      const pending = this.pending
      if (pending) {
        this.pending = null
        pending.resolve(line)
      } else {
        this.queued.push(line)
      }
    })
    this.readline.on('close', () => {
      input.removeListener('data', trackChunk)
      this.closed = true
      const pending = this.pending
      this.pending = null
      pending?.reject(new Error('Input closed.'))
    })
  }

  async readLine(prompt: string): Promise<string> {
    this.output.write(prompt)
    const queued = this.queued.shift()
    if (queued !== undefined) return queued
    if (this.closed) throw new Error('Input closed.')
    if (this.pending) throw new Error('Line input already has an active reader.')
    return new Promise<string>((resolve, reject) => {
      this.pending = { resolve, reject }
    })
  }

  /** Consent never consumes lines buffered before this request. */
  async readConsent(prompt: string): Promise<string> {
    this.queued.length = 0
    this.discardPartial = this.partialLine
    return this.readLine(prompt)
  }

  cancelRead(): boolean {
    const pending = this.pending
    if (!pending) return false
    this.pending = null
    pending.reject(new LineInputCancelledError())
    return true
  }

  close(): void {
    this.readline.close()
  }
}
