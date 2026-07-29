import type { PermissionAnswer, RunResult } from '../engine/types.js'
import { plainBounded } from '../interaction/format.js'
import type { Announcement, InteractionSnapshot } from '../interaction/types.js'
import type { LineInput } from './line-input.js'
import { LineInputCancelledError } from './line-input.js'
import { formatAccessiblePermission } from './permission-format.js'
import type {
  AccessiblePermissionRequest,
  DetailRequest,
  InteractivePresentation,
  PromptRequest,
} from './types.js'

export interface ScreenReaderPresentationOptions {
  input: LineInput
  write: (chunk: string) => void
}

export class ScreenReaderPresentation implements InteractivePresentation {
  private inputTail: Promise<void> = Promise.resolve()
  private inputActive = false
  private readonly pendingAnnouncements: string[] = []
  private closed = false
  private announcedResult: RunResult['status'] | null = null

  constructor(private readonly options: ScreenReaderPresentationOptions) {}

  async start(_initial: InteractionSnapshot): Promise<void> {
    this.writeLine('Status: Athena screen-reader mode is ready.')
  }

  announce(item: Announcement): void {
    const line = plainBounded(item.text, 1_024)
    if (!line) return
    if (line === 'Completed: Work completed.') this.announcedResult = 'completed'
    else if (line === 'Failed: Work failed.') this.announcedResult = 'error'
    else if (line === 'Attention: Run limit reached.') this.announcedResult = 'limit'
    else if (line === 'Attention: Work was canceled.') this.announcedResult = 'aborted'
    if (this.inputActive) this.pendingAnnouncements.push(line)
    else this.writeLine(line)
  }

  prompt(request: PromptRequest): Promise<string> {
    return this.withInput(async () => this.options.input.readLine(
      `${plainBounded(request.label, 80) || 'You'}: `,
    ))
  }

  requestPermission(request: AccessiblePermissionRequest): Promise<PermissionAnswer> {
    return this.withInput(async () => {
      this.writeBlock(formatAccessiblePermission(request))
      try {
        for (;;) {
          const answer = (await this.options.input.readLine('Permission choice: ')).trim().toLowerCase()
          if (answer === 'y') return 'allow-once'
          if (answer === 'a') return 'allow-always'
          if (answer === 'n') return 'deny'
          this.writeLine('Permission: Enter y, a, or n.')
        }
      } catch (error) {
        if (!(error instanceof LineInputCancelledError)) throw error
        this.writeLine('Permission: Denied because cancellation was requested.')
        return 'deny'
      }
    })
  }

  cancelPendingInput(): boolean {
    return this.options.input.cancelRead?.() ?? false
  }

  showDetails(request: DetailRequest): void {
    const line = plainBounded(request.text, 4_096)
    if (!line) return
    this.writeLine(/^(Status|Attention|Permission|Advisory|Completed|Failed):/.test(line)
      ? line
      : `Status: ${line}`)
  }

  /** Assistant final text remains ordinary output, separate from semantic status. */
  writeAssistantText(value: string): void {
    for (const line of value.split('\n')) {
      const safe = plainBounded(line, 4_096)
      if (safe) this.options.write(`${safe}\n`)
    }
  }

  acknowledgeCancellation(accepted: boolean): void {
    this.writeLine(`Status: Cancellation ${accepted ? 'accepted' : 'was not active'}.`)
  }

  async close(result: RunResult): Promise<void> {
    await this.inputTail
    if (this.closed) return
    this.closed = true
    this.flushAnnouncements()
    const line = result.status === 'completed'
      ? 'Completed: Work completed.'
      : result.status === 'error'
        ? 'Failed: Work failed.'
        : result.status === 'limit'
          ? 'Attention: Run limit reached.'
          : 'Attention: Work was canceled.'
    if (this.announcedResult !== result.status) this.writeLine(line)
    this.options.input.close()
  }

  private withInput<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.inputTail.then(async () => {
      this.inputActive = true
      try {
        return await operation()
      } finally {
        this.inputActive = false
        this.flushAnnouncements()
      }
    })
    this.inputTail = result.then(() => undefined, () => undefined)
    return result
  }

  private flushAnnouncements(): void {
    for (const line of this.pendingAnnouncements.splice(0)) this.writeLine(line)
  }

  private writeBlock(value: string): void {
    for (const line of value.split('\n')) this.writeLine(line)
  }

  private writeLine(value: string): void {
    const line = plainBounded(value, 4_096)
    if (line) this.options.write(`${line}\n`)
  }
}
