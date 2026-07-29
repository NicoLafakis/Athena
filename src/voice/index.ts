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
export {
  OPENAI_VOICE_ENV,
  OPENAI_VOICE_VAULT_REF,
  resolveVoiceKey,
  saveVoiceKey,
  type ResolvedVoiceKey,
} from './credentials.js'
export {
  DEFAULT_REALTIME_MODEL,
  REALTIME_MODELS,
  RealtimeVoiceClient,
  sanitizeVoiceUsage,
  validateRealtimeKey,
  type RealtimeToolCall,
  type RealtimeToolHandler,
  type RealtimeTurnResult,
  type RealtimeVoiceClientOptions,
  type RealtimeVoiceModel,
} from './realtime.js'
export {
  probeWindowsSpeech,
  recognizeWindowsPhrase,
  stripWakePhrase,
  speakWindowsText,
  playWindowsPcm,
  runPowerShell,
  type PowerShellRunner,
  type RecognizedPhrase,
  type SpeechBackendProbe,
} from './windows-speech.js'
export {
  KeyboardVoiceCommandInput,
  WindowsWakeCommandInput,
  athenaDelegateArgs,
  runAthenaDelegate,
  runVoiceProbe,
  runVoiceSession,
  type DelegateResult,
  type DelegateRunner,
  type VoiceCommandInput,
  type VoiceRealtimeClient,
  type VoiceSessionOptions,
} from './daemon.js'
