import type { z } from 'zod'
import type { VoiceContextSchema, VoiceFunctionCallSchema } from './schemas.js'

export type VoiceContext = z.infer<typeof VoiceContextSchema>
export type VoiceFunctionCall = z.infer<typeof VoiceFunctionCallSchema>

export interface VoiceSession {
  id: string
  lastActiveAt: string
}

export type VoiceRouteResult =
  | { kind: 'selected'; sessionId: string; reason: 'explicit' | 'foreground' | 'recent' }
  | { kind: 'clarification'; candidates: string[]; reason: 'unknown-explicit' | 'ambiguous' }
  | { kind: 'unavailable'; reason: 'no-sessions' }

export type VoiceFunctionResolution =
  | { kind: 'execute'; action: 'delegate'; text: string }
  | { kind: 'execute'; action: 'status' }
  | { kind: 'execute'; action: 'focus' | 'approve' | 'deny' | 'cancel'; targetId: string }
  | { kind: 'confirmation-required'; action: 'approve' | 'deny' | 'cancel'; targetId: string }
  | { kind: 'rejected'; reason: 'malformed-call' | 'unknown-session' | 'unknown-permission' }

export interface VoiceConfirmationRequest {
  id: string
  action: 'approve' | 'deny' | 'cancel'
  targetId: string
  prompt: string
}

export type VoiceConfirmationResult =
  | { kind: 'execute'; action: 'approve' | 'deny' | 'cancel'; targetId: string }
  | { kind: 'rejected'; reason: 'confirmation-declined' | 'unknown-confirmation' }
