import { plainBounded } from '../interaction/format.js'
import { randomUUID } from 'node:crypto'
import { VoiceFunctionCallSchema } from './schemas.js'
import type {
  VoiceConfirmationRequest,
  VoiceConfirmationResult,
  VoiceFunctionResolution,
} from './types.js'

export type RecognitionResult = { ok: true; text: string } | { ok: false }
export type VoiceInputResult =
  | { kind: 'prompt' | 'command'; text: string }
  | { kind: 'fallback'; message: 'Voice recognition failed. Continue by keyboard.' }

export class VoiceInputAdapter {
  accept(result: RecognitionResult): VoiceInputResult {
    if (!result.ok) return { kind: 'fallback', message: 'Voice recognition failed. Continue by keyboard.' }
    const text = plainBounded(result.text, 4_096)
    if (!text) return { kind: 'fallback', message: 'Voice recognition failed. Continue by keyboard.' }
    return { kind: text.startsWith('/') ? 'command' : 'prompt', text }
  }
}

export function resolveVoiceFunctionCall(
  input: unknown,
  context: { sessionIds: readonly string[]; pendingPermissionIds: readonly string[] },
): VoiceFunctionResolution {
  const parsed = VoiceFunctionCallSchema.safeParse(input)
  if (!parsed.success) return { kind: 'rejected', reason: 'malformed-call' }
  const call = parsed.data
  if (call.name === 'delegate') {
    return { kind: 'execute', action: 'delegate', text: plainBounded(call.arguments.prompt, 4_096) }
  }
  if (call.name === 'status') return { kind: 'execute', action: 'status' }
  if (call.name === 'focus') {
    return context.sessionIds.includes(call.arguments.sessionId)
      ? { kind: 'execute', action: 'focus', targetId: call.arguments.sessionId }
      : { kind: 'rejected', reason: 'unknown-session' }
  }
  const targetId = call.name === 'cancel'
    ? call.arguments.sessionId
    : call.arguments.permissionId
  const exists = call.name === 'cancel'
    ? context.sessionIds.includes(targetId)
    : context.pendingPermissionIds.includes(targetId)
  if (!exists) {
    return { kind: 'rejected', reason: call.name === 'cancel' ? 'unknown-session' : 'unknown-permission' }
  }
  return { kind: 'confirmation-required', action: call.name, targetId }
}

export class VoiceConfirmationGate {
  private readonly pending = new Map<string, VoiceConfirmationRequest>()

  constructor(private readonly idFactory: () => string = randomUUID) {}

  begin(
    resolution: Extract<VoiceFunctionResolution, { kind: 'confirmation-required' }>,
  ): VoiceConfirmationRequest {
    const id = plainBounded(this.idFactory(), 256)
    const request: VoiceConfirmationRequest = {
      id,
      action: resolution.action,
      targetId: resolution.targetId,
      prompt: `Confirm ${resolution.action} for ${resolution.targetId}. Say confirm to continue.`,
    }
    this.pending.set(id, request)
    while (this.pending.size > 16) {
      const oldest = this.pending.keys().next().value as string | undefined
      if (!oldest) break
      this.pending.delete(oldest)
    }
    return request
  }

  confirm(id: string, recognizedText: string): VoiceConfirmationResult {
    const request = this.pending.get(id)
    if (!request) return { kind: 'rejected', reason: 'unknown-confirmation' }
    this.pending.delete(id)
    if (plainBounded(recognizedText, 64).toLowerCase() !== 'confirm') {
      return { kind: 'rejected', reason: 'confirmation-declined' }
    }
    return { kind: 'execute', action: request.action, targetId: request.targetId }
  }
}
