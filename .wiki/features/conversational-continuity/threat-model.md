# Conversational Continuity — Threat Model

> [Overview](00-overview.md) · [PRD](prd.md) · [Rollout](rollout.md)

## Assets and trust boundaries

Assets include private conversations, relationship context, preferences, decisions,
project-specific details, session identifiers, source references, and user trust in what
Athena says she remembers.

Trust boundaries include user vs. assistant/model text; current project vs. global user
memory; source sessions vs. derived summaries; local machine vs. any network/provider;
and source history vs. active semantic memories.

## Threats and mitigations

| Threat | Example | Mitigation |
|---|---|---|
| False autobiographical memory | A hypothetical is saved as a plan or preference | Speech-act labels, source context, conservative promotion, inspect/reject controls |
| Context collapse | A summary omits “I was considering” or later reversal | Source refs, adjacent-turn reconstruction, temporal/versioned claims |
| Cross-project disclosure | Private project history appears in an unrelated task | No broad prompt injection; scoped retrieval; retrieve across projects only when relevant to user request |
| Secret propagation | Credential appears in a memory summary or search result | Existing redaction plus summary-specific redaction tests; never copy full transcripts |
| Stale memory | Old decision is stated as current | Observed/valid time, supersession, freshness ranking, current source precedence |
| Index poisoning | Model supplies a forged source path or ID | Server-authored identifiers; strict schema; resolve only under known local roots |
| Forgotten data resurrection | Rebuild recreates a deleted memory from source history | Durable tombstones/suppression records participate in every rebuild |
| Search side-channel | Query diagnostics leak private topic/content | Log counts, durations, index version, source IDs only; never query or result text |
| Corrupt/hostile records | Malformed JSON or control characters enter context | Zod validation, bounds, safe text formatting, per-record isolation, atomic writes |
| Unauthorized project setting | Project asks to add all history or sync it externally | Global user policy only; no network retrieval or project-controlled retention changes |
| Model overstates evidence | Response invents a source or claims certainty | Retrieval result includes validated refs; no-hit/conflict contract; tests assert source-backed context |

## Security invariants

- Continuity is local and advisory; it cannot authorize a tool, override current runtime
  truth, or silently transmit historical content.
- Every semantic fact and rollup points to source episode(s); no unlinked personal claim
  is eligible for durable retrieval.
- No inferred sensitive trait is promoted. Sensitive material stays source-only unless
  the user explicitly asks Athena to remember it and policy permits it.
- Forgetting applies to derived records and future rebuilds; source session trash/restore
  remains governed by the existing explicit session commands.
- Retrieval returns no more content than the query needs.

## Review gates

- Red-team ambiguous and contradictory conversations, quoted prompt injection, fake
  timestamps/source IDs, and instructions embedded in retrieved content.
- Inspect all prompt paths to ensure historical content is clearly delimited as untrusted
  context and cannot set system instructions.
- Verify secret/redaction behavior across summaries, time rollups, CLI output, prompt
  context, logs, and deletion tombstones.
- Test cross-project and restore/delete behavior with two independent project stores.
