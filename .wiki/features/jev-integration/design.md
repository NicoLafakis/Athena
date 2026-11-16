# Advisory architecture and operational budgets

[Overview](00-overview.md) | [Existing branch](existing-integration.md)

## Proposed flow

```text
canonical user turn / approved public candidate inputs
  -> local eligibility, authority and payload-scope checks
  -> redaction + bounded allowlisted DTO + size check
  -> optional DecisionClient / pinned TypeSafe transport
  -> strict typed validation + uncertainty/threshold policy
  -> advisory suggestion tied to source revision and turn ID
  -> local consumer revalidates eligibility, source and user intent
  -> existing generation / retrieval / review pathway
```

Extend `src/decision` from the continuity branch. Do not put Jev in `ModelClient`, present it as a streaming chat provider, build a separate agent loop, or place vendor logic in each presentation. The shared controller owns lifecycle and cancellation; domain-specific consumers own questions and application policy. A service result cannot acquire authority simply by appearing in system prompt context.

## Proposed domain contract

Keep the existing decision/fallback union. Add domain DTOs and question/policy versions rather than an unbounded `evaluate anything` tool. Internally record feature ID, current turn ID, input-source revisions, schema/question/policy version, requested and actual model, selected typed values, usage and terminal outcome. Never store payload text in the decision ledger. Results from an old turn, cancelled job, changed source or changed feature configuration are discarded.

Response validation must include exact requested question IDs/types and expected option keys; finite bounded values; normalized probability mass within a documented numerical tolerance; selected Choice consistent with distribution; valid Score range/legend; expected pinned actual model; and nonnegative finite token counts. An unexpected model or unsupported field shape is a fallback, not a best-effort reinterpretation. Do not accept generated prose or parse strings into executable paths. Local deterministic sorting/tie-breaks use stable IDs.

## Questions and uncertainty

Use Choice for unordered labels, Score for described ordered levels, Noul for one binary proposition. Score is not an exact count and Noul 0.5 means uncertainty, not medium quality. Batch independent questions sharing the same approved state. A later question that actually needs newly retrieved evidence is a new request, charged to the same turn budget. Do not create a question cascade merely to inflate certainty. [TypeSafe primitives](https://docs.typesafe.ai/primitives)

For new choices pair an applicability Noul when the option list is incomplete. The old recall `none` label has task-specific evidence; preserve it during reconciliation and compare a companion-Noul alternative as a separately versioned experiment, not an untested rewrite. [Choice guidance](https://docs.typesafe.ai/primitives)

Keep existing recall and speech-act 0.98 confidence thresholds until reevaluated. For new features select cutoffs on calibration data and freeze before holdout. Confidence is a distribution-concentration statistic, not measured real-world accuracy. Do not count confidence and top probability as independent votes. Expose `abstain`, unavailable, invalid and cancelled distinctly. [Confidence reference](https://docs.typesafe.ai/confidence)

## Proposed limits, not measurements

| Resource | Initial limit / behavior |
|---|---|
| Startup | No probe, auth prompt or inference on boot; setup failure cannot abort startup. |
| Current-request intake | Preserve 12,000-character post-redaction cap and 2,000 ms total wall deadline, 1,900 ms SDK attempt, no SDK retries. |
| Expanded payload | Max 24 KiB UTF-8 serialized state and 32 KiB complete request, plus conservative per-model token preflight; no silent truncation or long-context headers. |
| New questions | Max 24 independent questions/request; max 12 candidates for first-pass suggestion/ranking. |
| Active-turn fan-out | At most 2 Jev requests total, including legacy intake; aggregate Jev wall budget 2 seconds, not 2 seconds per feature. Legacy intake has priority; optional hints skip if budget exhausted. |
| Outcome target | Added p95 active-turn latency <= 500 ms on Helios, p99 <= 2 seconds. Failure reverts without an extra reasoning call just to classify. |
| Run call budget | Max 200 Jev attempts/session, hard reserve before dispatch. No unbounded background polling. |
| Spend | Proposed additional cap $0.01/session and $0.10/local day, counted inside existing total run cost limit. If rate unknown, skip optional call rather than assume zero. |
| Circuit breaker | After 3 consecutive transient failures, skip new calls for 60 seconds; authorization errors disable for that session with actionable notice. No hidden test probes. |
| Memory cache | Optional process-only LRU, max 128 entries, TTL 5 minutes; no on-disk payload cache. Key includes scope, input digest, source revisions, model and all question/policy versions. Clear on disable or scope change. |
| Child agents | No independent Jev budgets or inherited external-data scope by default. Suggestions originate in parent; any future child use shares root reservations. |

These budgets may lower coverage. Do not weaken them to make a benchmark look better. Preserve user-configured stricter limits. Confirm targets on Node 20/22 and Windows/macOS/Linux before cross-platform release.

## Failure and telemetry

Missing key, disabled feature, invalid input, input too large, low confidence, timeout, cancellation, rate limit, overload or malformed answer all fall back to the exact preexisting local route. Fail closed for authority: an advisory fallback never means approve. Do not retry 400/401/413/415/422; active-turn retries remain zero, including 429/529. A later offline evaluator may use bounded backoff under its own approved budget. Official API error semantics are [documented here](https://docs.typesafe.ai/api/errors).

Account for each provider attempt at the TypeSafe boundary with a logical request ID and content-free token/cost ledger. Preserve `src/engine/telemetry.ts`, `src/brain/vmp-ledger.ts` and VMP's opt-in scalar-only rules. Record feature, pinned/actual model, schema version, outcome, elapsed time, input/output tokens and reserved/actual cost. Unknown usage after timeout remains unknown, not zero; keep reservation or conservative maximum. Feature outcomes must not leak user text into labels, exceptions or diagnostics. Doctor/status reports configuration versus last observed availability honestly, without a paid probe.

TUI, append-only and voice use existing semantic announcements. No new fullscreen chrome is necessary; any later chrome requires row-budget and every-frame content-signature verification. Information about fallback is not a new permission prompt.
