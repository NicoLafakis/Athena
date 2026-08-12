import { randomUUID } from 'node:crypto'
import type { Message } from '@anthropic-ai/sdk/resources/messages'
import type { Attempt, LedgerStore, Meter } from '../../api-calculator/src/types.js'
import { recordAttempt } from '../../api-calculator/src/ledger.js'
import { buildAttempt } from '../../api-calculator/src/normalize.js'
import type { TokenUsage } from './types.js'

export type TelemetryRecorder = (input: Omit<Attempt, 'meters'> & { meters: Meter[] }) => void

/**
 * Builds a fire-and-forget recorder backed by a LedgerStore.
 * The returned function can be passed into AnthropicClient; invalid telemetry
 * is silently dropped so a ledger failure never affects the model request.
 */
export function makeTelemetryRecorder(store?: LedgerStore): TelemetryRecorder | undefined {
  if (!store) return undefined
  return (input) => {
    recordAttempt(store, buildAttempt(input))
  }
}

/**
 * Maps Anthropic SDK usage fields onto normalized meters.
 * Cache classes are disjoint per Anthropic docs; cached/reasoning subset logic
 * does not apply here.
 */
export function anthropicUsageMeters(usage: Message['usage']): Meter[] {
  const meters: Meter[] = []
  if (typeof usage.input_tokens === 'number') {
    meters.push({ name: 'input_uncached', value: usage.input_tokens, unit: 'token', canonical: 'input_uncached' })
  }
  if (typeof usage.cache_read_input_tokens === 'number') {
    meters.push({ name: 'cache_read', value: usage.cache_read_input_tokens, unit: 'token', canonical: 'cache_read' })
  }
  if (typeof usage.cache_creation_input_tokens === 'number') {
    meters.push({ name: 'cache_write', value: usage.cache_creation_input_tokens, unit: 'token', canonical: 'cache_write' })
  }
  if (typeof usage.output_tokens === 'number') {
    meters.push({ name: 'output', value: usage.output_tokens, unit: 'token', canonical: 'output' })
  }
  return meters
}

/**
 * Maps OpenAI Responses API usage onto normalized meters. Canonical names match
 * api-calculator's openaiMeters: cached/reasoning are SUBSETS of the totals and must
 * never be added on top (provider overlap rule).
 */
export function openaiUsageMeters(usage: {
  input_tokens?: number
  output_tokens?: number
  input_tokens_details?: { cached_tokens?: number }
  output_tokens_details?: { reasoning_tokens?: number }
}): Meter[] {
  const meters: Meter[] = []
  if (typeof usage.input_tokens === 'number') {
    meters.push({ name: 'prompt_total', value: usage.input_tokens, unit: 'token', canonical: 'prompt_total' })
  }
  if (typeof usage.input_tokens_details?.cached_tokens === 'number') {
    meters.push({ name: 'cache_read', value: usage.input_tokens_details.cached_tokens, unit: 'token', canonical: 'cache_read' })
  }
  if (typeof usage.output_tokens === 'number') {
    meters.push({ name: 'completion_total', value: usage.output_tokens, unit: 'token', canonical: 'completion_total' })
  }
  if (typeof usage.output_tokens_details?.reasoning_tokens === 'number') {
    meters.push({ name: 'reasoning', value: usage.output_tokens_details.reasoning_tokens, unit: 'token', canonical: 'reasoning' })
  }
  return meters
}

export function tokenUsageMeters(usage: TokenUsage): Meter[] {
  return [
    { name: 'input_uncached', value: usage.inputTokens, unit: 'token', canonical: 'input_uncached' },
    { name: 'cache_read', value: usage.cacheReadTokens, unit: 'token', canonical: 'cache_read' },
    { name: 'cache_write', value: usage.cacheWriteTokens ?? 0, unit: 'token', canonical: 'cache_write' },
    { name: 'output', value: usage.outputTokens, unit: 'token', canonical: 'output' },
  ].filter((m) => Number.isFinite(m.value) && m.value >= 0)
}

export function newLogicalRequestId(): string {
  return randomUUID()
}
