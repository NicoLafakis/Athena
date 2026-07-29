import { plainBounded } from '../interaction/format.js'
import type { Announcement } from '../interaction/types.js'

export type SpeechOwnership = 'off' | 'exclusive' | 'supplemental'

export interface SpeechDecision {
  speak: boolean
  text?: string
  reason: 'disabled' | 'screen-reader-owner' | 'routine-suppressed' | 'direct-speech-owner'
}

export function speechDecision(
  announcement: Announcement,
  ownership: SpeechOwnership,
  screenReaderActive: boolean,
): SpeechDecision {
  if (ownership === 'off') return { speak: false, reason: 'disabled' }
  if (screenReaderActive && ownership === 'exclusive') {
    return { speak: false, reason: 'screen-reader-owner' }
  }
  if (screenReaderActive && ownership === 'supplemental' && announcement.priority !== 'blocking') {
    return { speak: false, reason: 'routine-suppressed' }
  }
  return {
    speak: true,
    text: plainBounded(announcement.text, 1_024),
    reason: 'direct-speech-owner',
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
