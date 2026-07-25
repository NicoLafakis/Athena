# ADR-002: Governed Learning

**Status:** Accepted

## Decision

Self-improvement uses typed, immutable, trace-provenanced candidates. Candidates
are evaluated in isolated worktrees against baseline and protected held-out cases.
Code and policy promotion requires explicit human approval, a signed lineage,
canary evidence, and a reversible operation.

The runtime does not grant a generic "rewrite yourself and deploy" capability.
A successful trace may create only a low-confidence provisional hypothesis.

## Consequences

- Safety, cost, latency, and prior successes are monotonic promotion constraints.
- The learning system is slower than unconstrained self-editing.
- Stored lessons and synthetic evaluation wins are not described as L5 recursive
  improvement until repeated real tasks show a durable measured gain.
