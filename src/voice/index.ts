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
  ensureVoiceKey,
  resolveVoiceKey,
  saveVoiceKey,
  type EnsureVoiceKeyOptions,
  type ResolvedVoiceKey,
} from './credentials.js'
export {
  DEFAULT_REALTIME_MODEL,
  REALTIME_MODELS,
  RealtimeVoiceClient,
  buildVoiceInstructions,
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
  spawnWindowsWakeListener,
  stripWakePhrase,
  speakWindowsText,
  playWindowsPcm,
  playListeningCue,
  playStandbyCue,
  cueTonePcm,
  runPowerShell,
  type PowerShellRunner,
  type RecognizedPhrase,
  type SpeechBackendProbe,
} from './windows-speech.js'
export {
  KeyboardVoiceCommandInput,
  WindowsPersistentWakeInput,
  WindowsWakeCommandInput,
  athenaDelegateArgs,
  runAthenaDelegate,
  runVoiceProbe,
  runVoiceSession,
  waitForWakeProbe,
  type DelegateResult,
  type DelegateRunner,
  type WakeProbeOptions,
  type WakeProbeResult,
  type VoiceCommandInput,
  type VoiceCommand,
  type VoiceRealtimeClient,
  type VoiceSessionOptions,
  type WakeListenerProcess,
  type WakeListenerSpawner,
  type WindowsPersistentWakeOptions,
} from './daemon.js'
