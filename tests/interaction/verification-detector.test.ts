import { describe, expect, it } from 'vitest'
import { VerificationInvalidationDetector } from '../../src/interaction/detectors/verification.js'

describe('VerificationInvalidationDetector', () => {
  it('invalidates a successful gate after the next successful mutation exactly once', () => {
    const detector = new VerificationInvalidationDetector()
    detector.accept({
      type: 'tool-request', id: 'gate-1', name: 'Bash', input: { command: 'pnpm test' },
    })
    expect(detector.accept({
      type: 'tool-result', id: 'gate-1', name: 'Bash', output: 'all green', isError: false,
    })).toBeNull()

    detector.accept({
      type: 'tool-request', id: 'write-1', name: 'Write', input: { file_path: 'src/a.ts', content: 'secret' },
    })
    expect(detector.accept({
      type: 'tool-result', id: 'write-1', name: 'Write', output: 'wrote file', isError: false,
    })).toMatchObject({
      id: 'verification-invalidated:gate-1:write-1',
      summary: 'Test verification is stale after Write changed the workspace.',
      action: 'Run the affected verification gate again before claiming completion.',
    })

    detector.accept({ type: 'tool-request', id: 'write-2', name: 'Edit', input: {} })
    expect(detector.accept({
      type: 'tool-result', id: 'write-2', name: 'Edit', output: 'edited', isError: false,
    })).toBeNull()
  })

  it('does not invalidate for failed gates, failed mutations, reads, or unrelated shell commands', () => {
    const detector = new VerificationInvalidationDetector()
    detector.accept({ type: 'tool-request', id: 'bad-gate', name: 'Bash', input: { command: 'pnpm lint' } })
    detector.accept({ type: 'tool-result', id: 'bad-gate', name: 'Bash', output: 'red', isError: true })
    detector.accept({ type: 'tool-request', id: 'write', name: 'Write', input: {} })
    expect(detector.accept({
      type: 'tool-result', id: 'write', name: 'Write', output: 'done', isError: false,
    })).toBeNull()

    detector.accept({ type: 'tool-request', id: 'not-gate', name: 'Bash', input: { command: 'git status' } })
    detector.accept({ type: 'tool-result', id: 'not-gate', name: 'Bash', output: 'clean', isError: false })
    detector.accept({ type: 'tool-request', id: 'read', name: 'Read', input: { file_path: 'src/a.ts' } })
    expect(detector.accept({
      type: 'tool-result', id: 'read', name: 'Read', output: 'content', isError: false,
    })).toBeNull()
  })

  it('recognizes each shipped gate and bounds pending classifications', () => {
    const detector = new VerificationInvalidationDetector({ maxPending: 2 })
    expect(VerificationInvalidationDetector.classifyGate('Diagnostics', {})).toBe('Diagnostics')
    expect(VerificationInvalidationDetector.classifyGate('PowerShell', { command: 'pnpm typecheck' })).toBe('Typecheck')
    expect(VerificationInvalidationDetector.classifyGate('Bash', { command: 'pnpm lint && pnpm build' })).toBe('Lint/build')

    for (let index = 0; index < 10; index++) {
      detector.accept({ type: 'tool-request', id: `call-${index}`, name: 'Read', input: {} })
    }
    expect(detector.stats().pending).toBe(2)
  })
})
