import { AttributionLocalControls, AttributionLocalControlSchema, formatAttributionNotice } from './attribution-controls.js'
import { AttributionSession } from './attribution-session.js'
import { AttributionWorkerSupervisor } from './attribution-supervisor.js'
import type { InteractivePresentation } from '../presentation/types.js'

/** Dormant trusted local host. Never expose its methods to workers or model tools.
 * The injected presentation owns all text/Braille/speech; no second speech sink.
 */
export class AttributionLocalHost {
  private readonly controls: AttributionLocalControls
  private prompting = false
  private readonly detach: () => void

  constructor(
    private readonly session: AttributionSession,
    private readonly supervisor: AttributionWorkerSupervisor,
    private readonly presentation: Pick<InteractivePresentation, 'showDetails' | 'prompt'>,
  ) {
    this.controls = new AttributionLocalControls(session)
    this.detach = supervisor.onDiagnostic(code => {
      this.present([`Speaker worker status: ${code}. Identity remains advisory; ordinary Athena remains available.`])
    })
  }

  close(): void { this.supervisor.stop(); this.detach() }

  private present(lines: string[]): boolean {
    try {
      for (const text of lines) this.presentation.showDetails({ id: 'speaker-attribution', text })
      return true
    } catch { return false } // Display failure never prevents cleanup or creates consent.
  }

  /** Explicit local operator actions; consent is collected through the separate prompt. */
  operator(input: unknown): { lines: string[]; admission?: ReturnType<AttributionSession['admit']> } {
    const parsed = AttributionLocalControlSchema.safeParse(input)
    if (!parsed.success || parsed.data.action === 'consent') {
      const lines = ['Invalid local attribution action. Participant consent requires its disclosed prompt.']
      this.present(lines)
      return { lines }
    }
    const action = parsed.data.action
    const epoch = this.session.status().epoch
    const result: ReturnType<AttributionLocalControls['handle']> = action === 'start'
      ? { lines: [this.supervisor.start()
        ? formatAttributionNotice(this.session.status().active ? 'ready' : 'waiting-worker')
        : 'Attribution backend is unavailable or consent is incomplete. Capture remains off.'] }
      : this.controls.handle(parsed.data)
    if (action === 'stop') this.supervisor.stop()
    else if (action !== 'start' && this.session.status().epoch !== epoch) this.supervisor.revoke()
    if (action === 'status') {
      const backend = this.supervisor.status()
      result.lines.push(`Worker ${backend.diagnostic}; ${backend.retiring ? 'cleanup pending' : 'no pending cleanup'}.`)
    }
    this.present(result.lines)
    return result
  }

  /** The host must establish that the actual participant, not a proxy, answers.
   * IDs scope the prompt; they do not authenticate a person. No recording occurs here.
   */
  async requestCaptureConsent(participantId: string): Promise<boolean> {
    const parsed = AttributionLocalControlSchema.safeParse({ action: 'withdraw', participantId })
    if (!parsed.success || this.prompting) return false
    this.prompting = true
    // Pause before asking; existing consent may not sustain capture during this prompt.
    try { this.session.withdraw(participantId) } catch { this.prompting = false; return false }
    this.supervisor.revoke()
    const epoch = this.session.status().epoch
    const phrase = `I CONSENT ${participantId}`
    try {
      if (!this.present([
        'Local speaker attribution uses audio to create an anonymous speaker-tagged preview. Identity can be wrong and never authorizes Athena.',
        'Audio and speaker-tagged transcript preview are held in memory for this session. Queued audio and preview are cleared on pause, withdrawal or stop; worker cleanup may still be completing. This feature persists no transcript or voice profile and sends no audio to a cloud service. Enrollment and other uses need separate consent.',
        `Participant ${participantId}: opt in only for yourself. Enter ${phrase} to allow local capture; every other response declines. Capture starts separately.`,
      ])) return false
      const answer = await this.presentation.prompt({ id: `attribution-consent-${participantId}`, label: 'Participant capture consent' })
      if (this.session.status().epoch !== epoch) return false
      const accepted = answer === phrase
      const result = this.controls.handle({ action: 'consent', participantId, consent: {
        capture: accepted, cloudTransfer: false, transcriptPersistence: false, profileMatching: false,
      } })
      this.present(result.lines)
      return accepted && result.lines[0]?.startsWith('Participant consent recorded') === true
    } catch { return false } finally { this.prompting = false }
  }
}
