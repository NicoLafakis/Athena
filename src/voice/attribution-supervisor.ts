import { z } from 'zod'
import { AttributionWorkerChannel, type AttributionWorkerPort } from './attribution-ipc.js'
import { AttributionSession } from './attribution-session.js'

/** Injected process facade. The factory must be local and return without blocking.
 * Tests use fake processes; no concrete subprocess or inference backend is supplied.
 */
export interface AttributionProcess {
  port: AttributionWorkerPort
  onData(callback: (chunk: Uint8Array) => void): () => void
  onExit(callback: () => void): () => void
  /** Resolves only after confirmed exit; a request to kill is not confirmation. */
  kill(): Promise<void>
}
export type SupervisorDiagnostic = 'idle' | 'waiting-worker' | 'connected' | 'unavailable'
  | 'startup-timeout' | 'idle-timeout' | 'worker-exited' | 'transport-error' | 'revoked' | 'stopped' | 'cleanup-failed'

export class AttributionWorkerSupervisor {
  private channel: AttributionWorkerChannel | null = null
  private process: AttributionProcess | null = null
  private readonly detach: (() => void)[] = []
  private generation = 0
  private started = 0
  private lastOutput = 0
  private diagnostic: SupervisorDiagnostic = 'idle'
  private retiring: Promise<void> | null = null
  private cleanupFailed = false
  private observer: ((code: SupervisorDiagnostic) => void) | null = null

  constructor(
    private readonly session: AttributionSession,
    private readonly factory: () => AttributionProcess,
    private readonly now: () => number = () => performance.now(),
    private readonly startupMs = 5_000,
    private readonly idleMs = 30_000,
  ) {
    for (const value of [startupMs, idleMs]) z.number().finite().min(1).max(120_000).parse(value)
  }

  /** One trusted presentation owner; no unbounded listeners or worker prose. */
  onDiagnostic(observer: (code: SupervisorDiagnostic) => void): () => void {
    if (this.observer) throw new Error('Attribution presentation is already attached')
    this.observer = observer
    return () => { if (this.observer === observer) this.observer = null }
  }

  private report(code: SupervisorDiagnostic): void {
    if (this.diagnostic === code) return
    this.diagnostic = code
    try { this.observer?.(code) } catch { /* Output failure cannot prevent cleanup. */ }
  }

  private retire(reason: SupervisorDiagnostic): void {
    this.generation++
    const channel = this.channel
    const process = this.process
    this.channel = null
    this.process = null
    for (const remove of this.detach.splice(0)) { try { remove() } catch { /* Cleanup continues. */ } }
    channel?.checkDeadline() // Detect an already revoked epoch without pausing twice.
    channel?.close()
    if (!channel) this.session.pause()
    if (process) {
      try {
        const retiring = process.kill()
        this.retiring = retiring
        void retiring.then(() => {
          if (this.retiring === retiring) this.retiring = null
        }, () => {
          this.cleanupFailed = true
          this.report('cleanup-failed')
          // Keep the failed process counted; no unbounded replacement workers.
        })
      } catch { this.cleanupFailed = true; this.report('cleanup-failed') }
    }
    if (!this.cleanupFailed) this.report(reason)
  }

  /** Explicit trusted local start, never an automatic retry or worker command. */
  start(): boolean {
    this.tick()
    if (this.retiring || this.cleanupFailed) return false
    if (this.channel) return true
    if (!this.session.start()) return false
    try {
      this.process = this.factory()
      this.channel = new AttributionWorkerChannel(this.session, this.process.port, this.now)
      const generation = ++this.generation
      this.started = this.lastOutput = this.now()
      this.report('waiting-worker')
      const removeExit = this.process.onExit(() => {
        if (generation === this.generation) this.retire('worker-exited')
      })
      if (generation === this.generation) this.detach.push(removeExit)
      else { try { removeExit() } catch { /* Callback is generation-fenced. */ } }
      // A synchronously delivered exit must not register a callback on a retired process.
      if (!this.process || generation !== this.generation) return false
      const removeData = this.process.onData(chunk => {
        if (generation !== this.generation || !this.channel) return
        if (!(chunk instanceof Uint8Array) || chunk.byteLength > 1_048_576) {
          this.retire('transport-error'); return
        }
        for (let offset = 0; offset < chunk.length && this.channel; offset += 65_536) {
          const results = this.channel.receive(chunk.subarray(offset, offset + 65_536))
          if (results.some(result => ['ready', 'applied', 'heartbeat'].includes(result))) this.lastOutput = this.now()
          this.syncTransport()
        }
      })
      if (generation === this.generation) this.detach.push(removeData)
      else { try { removeData() } catch { /* Callback is generation-fenced. */ } }
      return this.channel !== null
    } catch { this.retire('unavailable'); return false }
  }

  private syncTransport(): void {
    if (!this.channel) return
    const state = this.channel.status()
    if (state.diagnostic === 'connected') this.report('connected')
    else if (state.diagnostic === 'epoch-changed') this.retire('revoked')
    else if (!['waiting-worker', 'connected'].includes(state.diagnostic)) this.retire('transport-error')
  }

  /** Future host schedules this timer; synthetic callers advance a fake clock. */
  tick(): void {
    this.syncTransport()
    if (!this.channel) return
    if (this.diagnostic === 'waiting-worker' && this.now() - this.started >= this.startupMs) this.retire('startup-timeout')
    else if (this.diagnostic === 'connected' && this.now() - this.lastOutput >= this.idleMs) this.retire('idle-timeout')
  }

  pump(): string {
    this.tick()
    const result = this.channel?.sendNext() ?? 'unavailable'
    this.syncTransport()
    return result
  }
  drain(): void { this.channel?.drain(); this.tick() }
  revoke(): void { this.retire('revoked') }
  stop(): void { this.retire('stopped'); this.session.stop() }
  status(): { diagnostic: SupervisorDiagnostic; running: boolean; retiring: boolean } {
    this.tick()
    return { diagnostic: this.diagnostic, running: this.channel !== null, retiring: this.retiring !== null || this.cleanupFailed }
  }
}
