import { describe, expect, it, vi } from 'vitest'
import { APITimeoutError, TypeSafeClient, type Fetch } from '@typesafe-ai/sdk'
import {
  createJevRecallRouter,
  JEV_MODEL,
  RECALL_ROUTES,
} from '../../src/decision/jev.js'

const probabilities = Object.fromEntries(RECALL_ROUTES.map((route) => [route, route === 'temporal-recall' ? 0.92 : 0.01]))
const MEMORY_SPEECH_ACTS = ['none', 'asked', 'stated', 'considered', 'preferred', 'decided', 'promised', 'corrected', 'retracted']
const speechActProbabilities = Object.fromEntries(
  MEMORY_SPEECH_ACTS.map((speechAct) => [speechAct, speechAct === 'preferred' ? 0.94 : 0.0075]),
)

describe('Jev recall router', () => {
  it('sends only the redacted current request and gets typed recall and memory-intake decisions in one call', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = []
    const usageEvents: Array<{ inputTokens?: number; outputTokens?: number }> = []
    const fetch: Fetch = async (url, init) => {
      requests.push({ url, init: init ?? {} })
      return new Response(JSON.stringify({
        model: JEV_MODEL,
        answers: {
          route: {
            type: 'choice',
            choice: 'temporal-recall',
            confidence: 0.92,
            probabilities,
          },
          speech_act: {
            type: 'choice',
            choice: 'preferred',
            confidence: 0.94,
            probabilities: speechActProbabilities,
          },
        },
        usage: { input_tokens: 17, output_tokens: 0 },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const router = createJevRecallRouter({
      apiKey: 'typesafe-test-key',
      fetch,
      telemetry: (event) => usageEvents.push(event),
    })

    const result = await router.classify('What did we decide? sk-ant-api03-abcdefabcd123456789')

    expect(result).toEqual({
      status: 'decision',
      value: {
        route: 'temporal-recall',
        confidence: 0.92,
        probabilities,
        speechAct: { act: 'preferred', confidence: 0.94, probabilities: speechActProbabilities },
      },
      usage: { inputTokens: 17, outputTokens: 0 },
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('https://api.typesafe.ai/v1/systemone')
    const body = JSON.parse(String(requests[0]?.init.body)) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['model', 'questions', 'state'])
    expect(body).toMatchObject({
      model: JEV_MODEL,
      state: 'What did we decide? [REDACTED]',
      questions: {
        route: {
          type: 'choice',
          criteria: Object.fromEntries(RECALL_ROUTES.map((route) => [route, expect.any(String)])),
        },
        speech_act: {
          type: 'choice',
          criteria: Object.fromEntries(MEMORY_SPEECH_ACTS.map((speechAct) => [speechAct, expect.any(String)])),
        },
      },
    })
    const speechActQuestion = JSON.stringify((body.questions as Record<string, unknown>)?.speech_act)
    expect(speechActQuestion).toContain('generic new-work commands')
    expect(speechActQuestion).toContain('earlier conversation')
    expect(JSON.stringify(body)).not.toContain('typesafe-test-key')
    expect(JSON.stringify(body)).not.toContain('previous session')
    expect(usageEvents[0]).toMatchObject({ inputTokens: 17, outputTokens: 0 })
  })

  it('does not call TypeSafe when the feature is disabled', async () => {
    const fetch = vi.fn<Fetch>(async () => new Response('{}'))
    const router = createJevRecallRouter({ enabled: false, apiKey: 'typesafe-test-key', fetch })

    await expect(router.classify('hello')).resolves.toEqual({ status: 'fallback', reason: 'disabled' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('falls back without a credential and never tries to create a network call', async () => {
    const fetch = vi.fn<Fetch>(async () => new Response('{}'))
    const router = createJevRecallRouter({ fetch })

    await expect(router.classify('hello')).resolves.toEqual({ status: 'fallback', reason: 'unavailable' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('falls back on a provider rate limit', async () => {
    const fetch: Fetch = async () => new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
      status: 429,
      headers: { 'content-type': 'application/json' },
    })
    const router = createJevRecallRouter({ apiKey: 'typesafe-test-key', fetch })

    await expect(router.classify('hello')).resolves.toEqual({ status: 'fallback', reason: 'rate-limited' })
  })

  it('classifies a TypeSafe SDK timeout as a timeout fallback', async () => {
    const systemOne = vi.spyOn(TypeSafeClient.prototype, 'systemOne')
      .mockRejectedValue(new APITimeoutError(1) as never)
    const router = createJevRecallRouter({ apiKey: 'typesafe-test-key', fetch: vi.fn<Fetch>() })

    try {
      const result = await router.classify('hello')
      expect(systemOne).toHaveBeenCalledOnce()
      expect(result).toEqual({ status: 'fallback', reason: 'timeout' })
    } finally {
      systemOne.mockRestore()
    }
  })

  it('does not send oversized requests to TypeSafe', async () => {
    const fetch = vi.fn<Fetch>(async () => new Response('{}'))
    const router = createJevRecallRouter({ apiKey: 'typesafe-test-key', fetch })

    await expect(router.classify('x'.repeat(12_001))).resolves.toEqual({
      status: 'fallback',
      reason: 'input-too-large',
    })
    expect(fetch).not.toHaveBeenCalled()
  })
})
