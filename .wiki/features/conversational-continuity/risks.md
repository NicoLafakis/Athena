# Conversational Continuity — Risk Register

> [Overview](00-overview.md) · [Threat model](threat-model.md) · [Rollout](rollout.md)

| Risk | Likelihood | Impact | Mitigation / exit signal |
|---|---|---|---|
| Summaries lose conversational qualifiers | Medium | Critical | Source-context reconstruction; speech-act fixtures; exact-recall answers cite source episodes |
| Cross-project recall discloses irrelevant private detail | Medium | Critical | Intent-gated retrieval; no global prompt dump; dogfood negative tests show no unrelated context |
| Long-term promotion overfits one statement | Medium | High | Explicit vs inferred distinction; independent-source threshold; reviewable candidates |
| Local index grows or search slows over years | Medium | Medium | Bounded derived data, per-period sharding, perf gates, measured backend decision |
| Timezone/DST mismatch yields wrong day | Medium | High | Persist UTC and source-local zone; DST/boundary tests; state fallback uncertainty |
| User forgets data but rebuild restores it | Low | Critical | Source-aware tombstones in every rebuild; forget/delete integration and regression tests |
| Existing session files contain sensitive content not covered by current redactor | Medium | High | Do not duplicate transcripts; add redaction before summaries; disclose local-only boundaries |
| Feature duplicates Memory/Experience/Learning | Medium | High | ADR boundaries; continuity index is derived; extend existing Memory lifecycle for durable facts |
| Optional index corruption harms boot | Low | High | Best-effort initialization, isolated records, recoverable explicit rebuild |
| Retrieval tool omitted by model for a recall question | Medium | High | Prompt contract plus deterministic recall intent tests; require source evidence for history claims |
