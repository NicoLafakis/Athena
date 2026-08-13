import { plainBounded } from '../interaction/format.js'
import type { Announcement, AnnouncementPriority } from '../interaction/types.js'

export type SpeechOwnership = 'off' | 'exclusive' | 'supplemental'

export type SpeechDecisionReason =
  | 'disabled'
  | 'screen-reader-owner'
  | 'routine-suppressed'
  | 'direct-speech-owner'

export interface SpeechDecision {
  speak: boolean
  text?: string
  reason: SpeechDecisionReason
}

/**
 * The ownership rule itself, by priority alone, so callers holding semantic-plane text
 * that is not an `Announcement` — a canonical permission record, say — decide the same
 * way instead of re-deriving the policy.
 */
export function speechOwnershipReason(
  priority: AnnouncementPriority,
  ownership: SpeechOwnership,
  screenReaderActive: boolean,
): SpeechDecisionReason {
  if (ownership === 'off') return 'disabled'
  if (screenReaderActive && ownership === 'exclusive') return 'screen-reader-owner'
  if (screenReaderActive && ownership === 'supplemental' && priority !== 'blocking') {
    return 'routine-suppressed'
  }
  return 'direct-speech-owner'
}

export function speechDecision(
  announcement: Announcement,
  ownership: SpeechOwnership,
  screenReaderActive: boolean,
): SpeechDecision {
  const reason = speechOwnershipReason(announcement.priority, ownership, screenReaderActive)
  if (reason !== 'direct-speech-owner') return { speak: false, reason }
  return {
    speak: true,
    text: plainBounded(announcement.text, 1_024),
    reason,
  }
}

export interface VoiceSpeechOutputOptions {
  ownership: SpeechOwnership
  screenReaderActive: boolean
  speak: (text: string) => void
}

export class VoiceSpeechOutput {
  constructor(private readonly options: VoiceSpeechOutputOptions) {}

  announce(announcement: Announcement): boolean {
    const decision = speechDecision(
      announcement,
      this.options.ownership,
      this.options.screenReaderActive,
    )
    if (!decision.speak || !decision.text) return false
    this.options.speak(decision.text)
    return true
  }
}
