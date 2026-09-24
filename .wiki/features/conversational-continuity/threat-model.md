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
| Cross-project disclosure | Private project history appears in an unrelated task or leaves the machine | Automatic recall requires a routed history request, locally resolves an explicit project as a hard filter, verifies source lines and tombstones, redacts/caps excerpts, and adds only the transient current answer prompt. Unknown/ambiguous project names clarify. |
| Secondary-provider disclosure | A second vendor receives text from a user turn | The product owner selected Jev route and speech-act classification; global `jev.enabled` defaults to true and a request still requires `TYPESAFE_API_KEY`. One call classifies both from only the current request after shared secret redaction. No hook context, prior history, episode text, source IDs, or project paths are sent. The shared redactor does not remove general personal information or arbitrary sensitive prose. |
| Stale semantic handoff | A semantic fact reaches the configured answer model after its source session is unavailable | Managed `Memory.read` verifies each session source line before returning text as a tool result; successful reads remain a provider handoff and are covered in the consent review |
| Secret propagation | Credential appears in a memory summary or search result | Existing redaction plus summary-specific redaction tests; never copy full transcripts |
| Stale memory | Old decision is stated as current | Observed/valid time, supersession, freshness ranking, current source precedence |
| Index poisoning | Model supplies a forged source path or ID | Server-authored identifiers; strict schema; resolve only under known local roots |
| Forgotten data resurrection | Rebuild recreates deleted session episodes or a semantically forgotten memory | Session deletion is protected by persistent source tombstones. Semantic forget clears the semantic body/description, drops source digests and secondary context metadata, retains typed source identities plus minimal lifecycle metadata, and candidate scans skip those lines after rebuild; the source session remains available through history retrieval. |
| Search side-channel | Query diagnostics leak private topic/content | Log counts, durations, index version, source IDs only; never query or result text |
| Corrupt/hostile records | Malformed JSON or control characters enter context | Zod validation, bounds, safe text formatting, per-record isolation, atomic writes |
| Unauthorized project setting | Project asks to add all history or sync it externally | Global user policy only; no network retrieval or project-controlled retention changes |
| Model overstates evidence | Response invents a source or claims certainty | Retrieval result includes validated refs; no-hit/conflict contract; tests assert source-backed context |

## Security invariants

- Continuity is local and advisory; it cannot authorize a tool, override current runtime
  truth, or transmit history without a current request routed for historical recall.
- A linked episode stores bounded derived summary/metadata and source IDs, not a copied
  transcript. Source text is reloaded from the local session and digest-checked before it
  is shown or sent. The user authorized scoped answer-time excerpts on 2026-09-23; the
  configured answer provider receives only redacted user/Athena text for the current
  history request, at most five episodes/4,000 characters. Jev, hooks, logs, and persisted
  session messages receive no retrieved history.
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
- Semantic-memory forget clears its body and replaces its description with an empty/generic
  terminal record; source digests, timezones, support episode IDs, original observation/
  validity dates, and project scope are removed. Typed source identities plus minimal
  lifecycle metadata suppress re-derivation from those exact lines. Candidate generation fails closed if any managed semantic record is
  malformed, so a damaged suppression marker cannot be ignored. The source session remains
  available for explicitly requested history; deleting source history remains the separate
  session delete action. Tests cover suppression, corruption, and session preservation.
- Jev is an additional network boundary, even though route and speech-act questions receive
  no historical context. Its result is untrusted advisory data: validate options and
  probability shapes locally, link persisted speech acts to exact user-line digests, keep
  source/scope/permission gates local, and fall back on
  disabled mode, missing key, timeout, rate limits, oversized input, or malformed
  responses. The answer prompt receives only a route hint and a caution not to invent
  missing history. Jev speech-act output is stored only as a content-free local label event;
  no request or response text is persisted. Run traces record only provider/model,
  outcome, elapsed time, and token counts, never state or response content.
- Retrieval returns no more content than the query needs.

## Review gates

- Red-team ambiguous and contradictory conversations, quoted prompt injection, fake
  timestamps/source IDs, and instructions embedded in retrieved content.
- For answer-time handoff, inspect every prompt path and ensure the authorized historical
  content is bounded, source-verified, redacted, clearly delimited as untrusted evidence,
  quoted to preserve message boundaries, and unable to set system instructions. Regression tests also prove no tool blocks, IDs,
  paths, hooks, Jev input, or persisted conversation messages cross this boundary.
- TypeSafe's model and privacy terms were reviewed for this integration on 2026-09-23,
  separately from the configured answer provider. Review them again before material
  changes to the payload or model. The fake SDK-boundary test asserts the exact request
  fields, and global settings define the current request-routing choice.
- Verify secret/redaction behavior across summaries, time rollups, CLI output, prompt
  context, logs, and deletion tombstones.
- The shared secret redactor does not classify general PII or arbitrary sensitive prose;
  this limitation is documented, and automatic semantic navigation excludes sensitive
  records. Review this boundary again if the redactor or payload scope changes.
- Test cross-project and restore/delete behavior with two independent project stores.
