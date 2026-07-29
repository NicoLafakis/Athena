export { VoiceContextSchema, VoiceFunctionCallSchema } from './schemas.js'
export type {
  VoiceContext,
  VoiceFunctionCall,
  VoiceSession,
  VoiceRouteResult,
  VoiceFunctionResolution,
  VoiceConfirmationRequest,
  VoiceConfirmationResult,
} from './types.js'
export { buildVoiceContext } from './context.js'
export { VoiceSessionRouter, type VoiceRouteRequest } from './session-router.js'
export {
  VoiceInputAdapter,
  VoiceConfirmationGate,
  resolveVoiceFunctionCall,
  type RecognitionResult,
  type VoiceInputResult,
} from './input.js'
export {
  VoiceSpeechOutput,
  speechDecision,
  type SpeechOwnership,
  type SpeechDecision,
  type VoiceSpeechOutputOptions,
} from './speech.js'
