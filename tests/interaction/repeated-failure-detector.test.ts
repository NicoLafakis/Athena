import { describe, expect, it } from 'vitest'
import { RepeatedFailureDetector } from '../../src/interaction/detectors/repeated-failure.js'

describe('RepeatedFailureDetector', () => {
  it('emits once on the unchanged second failure and stores no raw input', () => {
    const detector = new RepeatedFailureDetector()
    const secret = 'never-retain-this-tool-secret'

    expect(detector.accept({
      type: 'tool-request',
      id: 'call-1',
      name: 'Write',
      input: { z: 1, secret, nested: { b: 2, a: 1 } },
    })).toBeNull()
    expect(detector.accept({
      type: 'tool-result', id: 'call-1', name: 'Write', output: 'failed once', isError: true,
    })).toBeNull()

    detector.accept({
      type: 'tool-request',
      id: 'call-2',
      name: 'Write',
      input: { nested: { a: 1, b: 2 }, secret, z: 1 },
    })
    const advisory = detector.accept({
      type: 'tool-result', id: 'call-2', name: 'Write', output: 'failed twice', isError: true,
    })
    expect(advisory).toMatchObject({
      id: expect.stringMatching(/^repeated-failure:Write:/),
      toolName: 'Write',
      summary: 'Write failed twice with unchanged input.',
    })
    expect(JSON.stringify(detector)).not.toContain(secret)
    expect(JSON.stringify(advisory)).not.toContain(secret)

    detector.accept({ type: 'tool-request', id: 'call-3', name: 'Write', input: { secret, z: 1, nested: { a: 1, b: 2 } } })
    expect(detector.accept({
      type: 'tool-result', id: 'call-3', name: 'Write', output: 'failed three times', isError: true,
    })).toBeNull()
  })

  it('resets on meaningful input change and on success', () => {
    const detector = new RepeatedFailureDetector()
    const fail = (id: string, input: unknown) => {
      detector.accept({ type: 'tool-request', id, name: 'Edit', input })
      return detector.accept({ type: 'tool-result', id, name: 'Edit', output: 'no', isError: true })
    }

    expect(fail('one', { value: 1 })).toBeNull()
    expect(fail('two', { value: 2 })).toBeNull()
    expect(fail('three', { value: 2 })).not.toBeNull()
    detector.accept({ type: 'tool-request', id: 'ok', name: 'Edit', input: { value: 2 } })
    expect(detector.accept({
      type: 'tool-result', id: 'ok', name: 'Edit', output: 'ok', isError: false,
    })).toBeNull()
    expect(fail('after-ok', { value: 2 })).toBeNull()
  })

  it('bounds pending calls and per-tool state', () => {
    const detector = new RepeatedFailureDetector({ maxPending: 3, maxTools: 2 })
    for (let index = 0; index < 20; index++) {
      detector.accept({ type: 'tool-request', id: `call-${index}`, name: `Tool-${index}`, input: { index } })
    }
    expect(detector.stats()).toEqual({ pending: 3, tools: 0 })

    for (let index = 17; index < 20; index++) {
      detector.accept({
        type: 'tool-result', id: `call-${index}`, name: `Tool-${index}`, output: 'failed', isError: true,
      })
    }
    expect(detector.stats()).toEqual({ pending: 0, tools: 2 })
  })
})
