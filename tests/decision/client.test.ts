import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  DecisionTransportError,
  OptionalDecisionClient,
  type DecisionTelemetryEvent,
  type DecisionTransport,
  type DecisionTransportOutput,
} from '../../src/decision/client.js'

const AnswerSchema = z.object({
  route: z.enum(['none', 'temporal-recall']),
}).strict()

const request = {
  payload: { redactedRequest: 'CONTINUITY_DECISION_SENTINEL' },
  responseSchema: AnswerSchema,
}

function client(options: {
  enabled?: boolean
  transport?: DecisionTransport
  timeoutMs?: number
  telemetry?: (event: DecisionTelemetryEvent) => void
} = {}): OptionalDecisionClient {
  return new OptionalDecisionClient({
    enabled: options.enabled ?? true,
    provider: 'typesafe',
    model: 'jev-1.13.0',
    timeoutMs: options.timeoutMs ?? 100,
    transport: options.transport,
    telemetry: options.telemetry,
  })
}

describe('OptionalDecisionClient', () => {
  it('returns a schema-validated typed decision', async () => {
    const transport: DecisionTransport = { evaluate: vi.fn(async () => ({ value: { route: 'temporal-recall' } })) }
    const result = await client({ transport }).evaluate(request)

    expect(result).toEqual({ status: 'decision', value: { route: 'temporal-recall' } })
    expect(transport.evaluate).toHaveBeenCalledOnce()
  })

  it('falls back when the provider response fails the caller schema', async () => {
    const transport: DecisionTransport = {
      evaluate: vi.fn(async () => ({
        value: { route: 'unknown-route' },
        usage: { inputTokens: 23, outputTokens: 1 },
      })),
    }
    const result = await client({ transport }).evaluate(request)

    expect(result).toEqual({
      status: 'fallback',
      reason: 'invalid-response',
      usage: { inputTokens: 23, outputTokens: 1 },
    })
  })

  it('makes zero transport calls while disabled', async () => {
    const transport: DecisionTransport = { evaluate: vi.fn(async () => ({ value: { route: 'none' } })) }
    const result = await client({ enabled: false, transport }).evaluate(request)

    expect(result).toEqual({ status: 'fallback', reason: 'disabled' })
    expect(transport.evaluate).not.toHaveBeenCalled()
  })

  it('falls back when no transport is configured', async () => {
    const result = await client().evaluate(request)

    expect(result).toEqual({ status: 'fallback', reason: 'unavailable' })
  })

  it('aborts and falls back when the transport exceeds its deadline', async () => {
    let transportSignal: AbortSignal | undefined
    const transport: DecisionTransport = {
      evaluate: vi.fn((_payload, options) => {
        transportSignal = options.signal
        return new Promise<DecisionTransportOutput>(() => {})
      }),
    }
    const result = await client({ transport, timeoutMs: 5 }).evaluate(request)

    expect(result).toEqual({ status: 'fallback', reason: 'timeout' })
    expect(transportSignal?.aborted).toBe(true)
  })

  it('uses a local fallback for provider rate limits', async () => {
    const transport: DecisionTransport = {
      evaluate: vi.fn(async () => { throw new DecisionTransportError('rate limited', 'rate-limited') }),
    }
    const result = await client({ transport }).evaluate(request)

    expect(result).toEqual({ status: 'fallback', reason: 'rate-limited' })
  })

  it('classifies a provider transport timeout as a timeout fallback', async () => {
    const transport: DecisionTransport = {
      evaluate: vi.fn(async () => { throw new DecisionTransportError('request timed out', 'timeout') }),
    }
    const result = await client({ transport }).evaluate(request)

    expect(result).toEqual({ status: 'fallback', reason: 'timeout' })
  })

  it('records content-free telemetry even when the provider fails', async () => {
    const events: DecisionTelemetryEvent[] = []
    const transport: DecisionTransport = {
      evaluate: vi.fn(async () => { throw new Error('CONTINUITY_DECISION_SENTINEL must not be logged') }),
    }
    const result = await client({ transport, telemetry: (event) => events.push(event) }).evaluate(request)

    expect(result.status).toBe('fallback')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      provider: 'typesafe',
      model: 'jev-1.13.0',
      outcome: 'provider-error',
    })
    expect(JSON.stringify(events)).not.toContain('CONTINUITY_DECISION_SENTINEL')
  })

  it('does not let a telemetry sink failure change the decision result', async () => {
    const transport: DecisionTransport = { evaluate: vi.fn(async () => ({ value: { route: 'none' } })) }
    const result = await client({
      transport,
      telemetry: () => { throw new Error('telemetry unavailable') },
    }).evaluate(request)

    expect(result).toEqual({ status: 'decision', value: { route: 'none' } })
  })

  it('records provider token usage without including request or response content', async () => {
    const events: DecisionTelemetryEvent[] = []
    const transport: DecisionTransport = {
      evaluate: vi.fn(async () => ({
        value: { route: 'temporal-recall' },
        usage: { inputTokens: 23, outputTokens: 0 },
      })),
    }

    const result = await client({ transport, telemetry: (event) => events.push(event) }).evaluate(request)

    expect(result.status).toBe('decision')
    expect(events[0]).toMatchObject({ inputTokens: 23, outputTokens: 0, outcome: 'decision' })
    expect(JSON.stringify(events)).not.toContain('CONTINUITY_DECISION_SENTINEL')
  })
})
