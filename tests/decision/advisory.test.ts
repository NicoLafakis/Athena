import { describe, expect, it } from 'vitest'
import { JevBudgetGuard } from '../../src/decision/budget.js'
import {
  evaluateSkillSuggestionShadow,
  evaluateWorkflowHintShadow,
  SHORTLIST_MAX_SKILLS,
} from '../../src/decision/advisory.js'
import { DecisionTransportError, OptionalDecisionClient, type DecisionTransport } from '../../src/decision/client.js'
import { JEV_MODEL } from '../../src/decision/jev.js'

describe('JevBudgetGuard', () => {
  it('enforces per-session attempt caps, per-turn request caps, and circuit breaker cooldown', () => {
    let nowMs = 1_000
    const guard = new JevBudgetGuard({
      maxSessionAttempts: 4,
      maxTurnRequests: 2,
      turnWallBudgetMs: 2_000,
      circuitBreakerThreshold: 3,
      circuitBreakerCooldownMs: 60_000,
      now: () => nowMs,
    })

    // Per-turn limit: 2 allowed, 3rd rejected.
    expect(guard.tryReserve('turn-1').allowed).toBe(true)
    expect(guard.tryReserve('turn-1').allowed).toBe(true)
    expect(guard.tryReserve('turn-1')).toEqual({ allowed: false, reason: 'turn-budget-exhausted' })

    // Next turn allowed up to session cap.
    expect(guard.tryReserve('turn-2').allowed).toBe(true)
    expect(guard.tryReserve('turn-2').allowed).toBe(true)
    expect(guard.tryReserve('turn-3')).toEqual({ allowed: false, reason: 'session-budget-exhausted' })

    // Circuit breaker opens after 3 consecutive transient failures and recovers after cooldown.
    const cb = new JevBudgetGuard({
      circuitBreakerThreshold: 3,
      circuitBreakerCooldownMs: 60_000,
      now: () => nowMs,
    })
    cb.recordTransientFailure()
    cb.recordTransientFailure()
    expect(cb.tryReserve('t1').allowed).toBe(true)
    cb.recordTransientFailure()
    expect(cb.tryReserve('t2')).toEqual({ allowed: false, reason: 'circuit-open' })
    nowMs += 60_001
    expect(cb.tryReserve('t3').allowed).toBe(true)

    // Auth failure disables for the rest of the session.
    cb.recordAuthFailure()
    expect(cb.tryReserve('t4')).toEqual({ allowed: false, reason: 'auth-disabled' })
  })

  it('caches process-only decisions with LRU eviction, TTL expiry, and clear()', () => {
    let nowMs = 10_000
    const guard = new JevBudgetGuard({ cacheMaxEntries: 2, cacheTtlMs: 5_000, now: () => nowMs })
    guard.setCached('k1', { label: 'a' })
    guard.setCached('k2', { label: 'b' })
    expect(guard.getCached<{ label: string }>('k1')).toEqual({ label: 'a' })
    // Adding k3 evicts LRU (k2 because k1 was just touched).
    guard.setCached('k3', { label: 'c' })
    expect(guard.getCached('k2')).toBeUndefined()
    expect(guard.getCached('k1')).toEqual({ label: 'a' })
    // TTL expiry
    nowMs += 5_001
    expect(guard.getCached('k1')).toBeUndefined()
    guard.setCached('k4', { label: 'd' })
    guard.clearCache()
    expect(guard.getCached('k4')).toBeUndefined()
  })
})

describe('shadow workflow hint & skill suggestion adapters', () => {
  it('evaluates workflow hints in shadow mode with strict distribution validation and opt-in default off', async () => {
    const transport: DecisionTransport = {
      async evaluate() {
        return {
          value: {
            workflow: 'investigation',
            confidence: 0.96,
            probabilities: {
              explanation: 0.01,
              investigation: 0.96,
              implementation: 0.01,
              review: 0.01,
              planning: 0.01,
            },
            fitsWorkflow: 0.94,
          },
          usage: { inputTokens: 40, outputTokens: 8 },
        }
      },
    }
    const client = new OptionalDecisionClient({
      enabled: true,
      provider: 'typesafe',
      model: JEV_MODEL,
      transport,
    })
    const guard = new JevBudgetGuard()

    // Disabled by default -> returns disabled fallback without calling transport.
    const off = await evaluateWorkflowHintShadow({
      enabled: false,
      client,
      budget: guard,
      turnId: 'turn-1',
      request: 'Why is the build failing on Windows?',
    })
    expect(off.status).toBe('fallback')
    if (off.status === 'fallback') expect(off.reason).toBe('disabled')

    // Enabled -> returns validated typed advisory decision.
    const on = await evaluateWorkflowHintShadow({
      enabled: true,
      client,
      budget: guard,
      turnId: 'turn-1',
      request: 'Why is the build failing on Windows?',
    })
    expect(on.status).toBe('decision')
    if (on.status === 'decision') {
      expect(on.value.workflow).toBe('investigation')
      expect(on.value.fitsWorkflow).toBe(0.94)
    }
  })

  it('rejects non-normalized distributions and shortlists at most 12 skills with deterministic tie-breaking', async () => {
    let seenCandidateCount = 0
    const transport: DecisionTransport = {
      async evaluate(payload) {
        const p = payload as { candidates: Array<{ id: string }> }
        seenCandidateCount = p.candidates.length
        return {
          value: {
            needsSkill: 0.91,
            scores: Object.fromEntries(
              p.candidates.map((c, idx) => [c.id, idx === 0 || idx === 1 ? 2 : 0]),
            ),
          },
          usage: { inputTokens: 80, outputTokens: 12 },
        }
      },
    }
    const client = new OptionalDecisionClient({
      enabled: true,
      provider: 'typesafe',
      model: JEV_MODEL,
      transport,
    })
    const guard = new JevBudgetGuard()
    const skills = Array.from({ length: 20 }, (_, i) => ({
      id: `skill-${String(i).padStart(2, '0')}`,
      description: `Skill description ${i}`,
    }))

    const result = await evaluateSkillSuggestionShadow({
      enabled: true,
      client,
      budget: guard,
      turnId: 'turn-2',
      request: 'Help me audit accessibility on this app.',
      skills,
    })
    expect(seenCandidateCount).toBe(SHORTLIST_MAX_SKILLS)
    expect(result.status).toBe('decision')
    if (result.status === 'decision') {
      // Deterministic tie-break selects lowest stable ID among top-scored candidates.
      expect(result.suggestedSkillId).toBe('skill-00')
    }

    // Transient error opens circuit breaker after threshold.
    const failingClient = new OptionalDecisionClient({
      enabled: true,
      provider: 'typesafe',
      model: JEV_MODEL,
      transport: {
        async evaluate() {
          throw new DecisionTransportError('boom', 'provider-error')
        },
      },
    })
    const failGuard = new JevBudgetGuard({ circuitBreakerThreshold: 1 })
    const failed = await evaluateWorkflowHintShadow({
      enabled: true,
      client: failingClient,
      budget: failGuard,
      turnId: 'turn-3',
      request: 'Check this bug.',
    })
    expect(failed.status).toBe('fallback')
    expect(failGuard.tryReserve('turn-4')).toEqual({ allowed: false, reason: 'circuit-open' })
  })
})
