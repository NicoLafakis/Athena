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
| Unreviewed candidate reaches the model | Candidate claim text enters an answer prompt as if it were established | The model-facing `Memory.read` blocks candidate, flagged, rejected, and tombstoned records; local review remains the only content display for those states |
| Context collapse | A summary omits “I was considering” or later reversal | Source refs, adjacent-turn reconstruction, temporal/versioned claims |
| Cross-project disclosure | Private project history appears in an unrelated task or leaves the machine | Current continuity search/show output is local CLI/slash only; no historical episode text enters provider prompts. Any future handoff requires explicit authorization, scoped retrieval, verified source refs, and prompt-isolation tests |
| Secondary-provider disclosure | An optional intent model receives user text without the user expecting a second vendor | Jev stays disabled by default and requires separate opt-in; the proposed first slice sends only a redacted current request, no prior history, source IDs, or project paths; provider terms and retention are reviewed before release |
| Stale semantic handoff | A semantic fact reaches the configured answer model after its source session is unavailable | Managed `Memory.read` verifies each session source line before returning text as a tool result; successful reads remain a provider handoff and are covered in the consent review |
| Secret propagation | Credential appears in a memory summary or search result | Existing redaction plus summary-specific redaction tests; never copy full transcripts |
| Stale memory | Old decision is stated as current | Observed/valid time, supersession, freshness ranking, current source precedence |
| Index poisoning | Model supplies a forged source path or ID | Server-authored identifiers; strict schema; resolve only under known local roots |
| Forgotten data resurrection | Rebuild recreates a deleted memory from source history | Required mitigation is source-aware tombstones in every rebuild; integration is not implemented yet |
| Search side-channel | Query diagnostics leak private topic/content | Log counts, durations, index version, source IDs only; never query or result text |
| Corrupt/hostile records | Malformed JSON or control characters enter context | Zod validation, bounds, safe text formatting, per-record isolation, atomic writes |
| Unauthorized project setting | Project asks to add all history or sync it externally | Global user policy only; no network retrieval or project-controlled retention changes |
| Model overstates evidence | Response invents a source or claims certainty | Retrieval result includes validated refs; no-hit/conflict contract; tests assert source-backed context |

## Security invariants

- Continuity is local and advisory; it cannot authorize a tool, override current runtime
  truth, or silently transmit historical content.
- A linked episode stores bounded derived summary/metadata and source IDs, not a copied
  transcript. Source text is reloaded from the local session and digest-checked before it
  is shown. At this implementation checkpoint, even verified source text is not sent to
  the configured model provider.
- Every semantic fact links to a persisted source message or event and may also identify
  supporting episodes; rollups link to source episodes. No unlinked personal claim is
  eligible for durable retrieval.
- Sensitive claims are excluded from inferred semantic-memory records; the linked episode
  index may still contain a bounded local summary under the episode policy. The original
  session remains canonical. An explicit remember request is separate and follows the
  explicit-memory policy; an inferred candidate cannot silently move sensitive text into
  durable semantic memory.
- The local candidate scanner skips newly encountered sensitive claims before semantic
  write. A synthetic regression fixture verifies that repeated salary text produces no
  candidate record. This does not erase legacy candidate files already present on a user
  machine; cleanup requires a separately designed lifecycle action.
- Candidate generation also skips a directly sourced message when the shared credential
  redactor would change it. This prevents old or manually edited unredacted credential text
  from being copied into a new semantic candidate.
- Forgetting and source-session trash/restore integration are not implemented yet. Their
  eventual behavior must follow the user's source-retention choice and prevent rebuild
  resurrection.
- A future Jev adapter is an additional network boundary, even when it receives no
  historical context. Its result is untrusted advisory data: validate the option and
  probability shape locally, keep all source/scope/permission gates local, and fall back
  on disabled mode, timeout, rate limits, or malformed responses. Do not log state,
  question text, or response content.
- Retrieval returns no more content than the query needs.

## Review gates

- Red-team ambiguous and contradictory conversations, quoted prompt injection, fake
  timestamps/source IDs, and instructions embedded in retrieved content.
- Before adding any provider handoff, inspect every prompt path and ensure authorized
  historical content is bounded, source-verified, clearly delimited as untrusted context,
  and cannot set system instructions.
- Before enabling Jev, review TypeSafe's then-current model and privacy terms separately
  from the configured answer provider. Test the exact request payload and confirm the
  consent setting covers the current user text sent for routing.
- Verify secret/redaction behavior across summaries, time rollups, CLI output, prompt
  context, logs, and deletion tombstones.
- Test cross-project and restore/delete behavior with two independent project stores.
