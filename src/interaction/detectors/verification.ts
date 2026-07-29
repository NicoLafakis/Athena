import type { EngineEvent } from '../../engine/types.js'

export interface VerificationInvalidationAdvisory {
  id: string
  summary: string
  action: string
}

export interface VerificationInvalidationDetectorOptions {
  maxPending?: number
}

type Classification =
  | { kind: 'gate'; label: string }
  | { kind: 'mutation'; name: string }

interface Verification {
  toolCallId: string
  label: string
}

const MUTATION_TOOLS = new Set(['Write', 'Edit', 'ApplyPatch', 'NotebookEdit'])
const GATE_PATTERN = /\bpnpm\s+(typecheck|lint|test|build)\b/gi

function trimOldest<K, V>(values: Map<K, V>, max: number): void {
  while (values.size > max) {
    const oldest = values.keys().next().value as K | undefined
    if (oldest === undefined) return
    values.delete(oldest)
  }
}

function gateLabel(command: string): string | null {
  const gates = [...command.matchAll(GATE_PATTERN)].map((match) => match[1]!.toLowerCase())
  const unique = [...new Set(gates)]
  if (unique.length === 0) return null
  return unique.map((gate, index) => index === 0
    ? gate[0]!.toUpperCase() + gate.slice(1)
    : gate).join('/')
}

/** Tracks only call classifications and a gate label; tool input and output are discarded. */
export class VerificationInvalidationDetector {
  private readonly pending = new Map<string, Classification | null>()
  private verification: Verification | null = null
  private readonly maxPending: number

  constructor(options: VerificationInvalidationDetectorOptions = {}) {
    this.maxPending = Math.max(1, options.maxPending ?? 256)
  }

  static classifyGate(toolName: string, input: unknown): string | null {
    if (toolName === 'Diagnostics') return 'Diagnostics'
    if (toolName !== 'Bash' && toolName !== 'PowerShell') return null
    if (!input || typeof input !== 'object') return null
    const command = (input as Record<string, unknown>)['command']
    return typeof command === 'string' ? gateLabel(command) : null
  }

  accept(event: EngineEvent): VerificationInvalidationAdvisory | null {
    if (event.type === 'tool-request') {
      const gate = VerificationInvalidationDetector.classifyGate(event.name, event.input)
      const classification: Classification | null = gate
        ? { kind: 'gate', label: gate }
        : MUTATION_TOOLS.has(event.name)
          ? { kind: 'mutation', name: event.name }
          : null
      this.pending.set(event.id, classification)
      trimOldest(this.pending, this.maxPending)
      return null
    }
    if (event.type !== 'tool-result') return null

    const classification = this.pending.get(event.id)
    this.pending.delete(event.id)
    if (!classification) return null
    if (classification.kind === 'gate') {
      this.verification = event.isError ? null : { toolCallId: event.id, label: classification.label }
      return null
    }
    if (event.isError || !this.verification) return null

    const verification = this.verification
    this.verification = null
    return {
      id: `verification-invalidated:${verification.toolCallId.slice(0, 96)}:${event.id.slice(0, 96)}`,
      summary: `${verification.label} verification is stale after ${classification.name} changed the workspace.`,
      action: 'Run the affected verification gate again before claiming completion.',
    }
  }

  stats(): { pending: number; hasVerification: boolean } {
    return { pending: this.pending.size, hasVerification: this.verification !== null }
  }
}
