# ADR 0003: Use Jev for Athena's recall routing and speech-act intake

- **Status:** Accepted and implemented; pinned recall routing and source-linked speech-act
  intake are integrated into the harness. Live Jev evaluations have been run on synthetic
  corpora; representative live-history dogfood remains open. Results are in
  [the calibration snapshot](../calibration.md).
- **Date:** 2026-09-23
- **Context:** Athena needs to recognize implicit continuity intent and select the
  appropriate local memory path without confusing a conversation model with the memory
  system itself.

## Decision

Use Jev as a typed decision service beside Athena's generative `ModelClient`. It is not an
answer model, memory database, source of truth, or permission authority. The `DecisionClient`
interface stays separate from streaming `ModelClient`; the harness builds its Jev adapter
in `src/decision/jev.ts` and invokes it once per inbound user request.

One System One request classifies the current inbound request for both its route and speech
act. The route chooses `none`, `continue-current`, `temporal-recall`, `topic-recall`,
`preference-or-fact`, `historical-decision`, or `similar-work`, validated against a strict
local schema. A high-confidence (`>= 0.98`) history route can invoke the local answer-time
retriever. `none` and `continue-current` cannot. When Jev is absent or below threshold, a
clear deterministic explicit-history phrase is the only fallback. The route is an intent
hint, not evidence that a matching memory exists; local source and scope checks remain
authoritative.

The routing contract gives a specific preference, fact, or decision precedence over a
time filter; a broad period summary uses `temporal-recall`. Finding the conversation about
an identifiable subject uses `topic-recall`, while asking what choice was made uses
`historical-decision`. Vague backward references and quoted sample text do not trigger
history retrieval, and immediate same-conversation interruption context uses
`continue-current`.

The TypeSafe request contains only the shared-secret-redactor-processed current user
request and fixed question definitions. It excludes hook-added context, conversation
history, retrieved episodes, summaries, semantic memory text, source IDs, and project
paths. The existing redactor targets known credential fields and secret-shaped tokens; it
does not remove names, general personal information, or arbitrary sensitive prose. The
product owner selected Jev routing on 2026-09-23. Global `jev.enabled` defaults to `true`
and can be set to `false` in `~/.athena/settings.json`; project settings cannot change it.
The API key is supplied through `TYPESAFE_API_KEY` and is not written to settings or
credentials files. A missing key means no Jev network call and a local explicit-recall
fallback. Jev never receives history. The user separately authorized scoped, redacted,
source-verified user/Athena excerpts to the configured answer model for a current history
request. That payload is capped at five episodes/4,000 characters; semantic text, rollup
summaries, tool blocks, source IDs, paths, and hook context are excluded.

The adapter pins model `jev-1.13.0` through TypeSafe JavaScript SDK `0.6.0`, disables SDK
request logging and retries, and enforces a two-second outer deadline with a 1.9-second
per-attempt SDK timeout. SDK timeouts are normalized to timeout fallbacks. Requests longer
than 12,000 characters are skipped. Invalid or
unknown choices, malformed probabilities, timeouts, missing credentials, rate limits, and
provider errors fall through to the ordinary answer path. A route hint is transient and is
not saved in session messages. Recall actions require confidence `>= 0.98`; synthetic
evaluation is reported both before and after this gate. The threshold is an operational
policy evaluated on a small synthetic set, not a statistically calibrated guarantee for
real conversations. `Noul` returns a yes probability without a separate confidence field;
do not treat it as an ordered score.

The product owner explicitly approved memory intake on 2026-09-23. Speech-act
classification is persisted only after Athena writes the current user message. Athena
resolves the source ID, timestamp, and line digest from its own session journal, then stores
a content-free local event for `preferred`, `decided`, `promised`, `corrected`, or
`retracted` labels when Jev confidence is at least 0.98. The event is accepted into an
episode only while it resolves to that exact user-authored line and digest.

Verified `preferred`, `decided`, and `promised` labels can support a candidate when the
same normalized user text appears in two or more independent sessions. Candidate generation
still applies redaction, sensitivity, completeness, and source-integrity checks. Promotion
rechecks the exact source lines. `corrected` and `retracted` labels are kept with their
episode context to help retrieval, but they do not automatically supersede, promote, or
delete semantic memory. The latest live synthetic evaluation returned 89/90 exact labels
across calibration and phrasing holdout. At the 0.98 persistence threshold, all 35/35
eligible persisted-label decisions were correct (38.9% combined coverage). These small
synthetic sets do not establish real-user precision.

Never give Jev authority to decide project trust, permission, tool execution, source
retention, forgetting, deletion, credential handling, or user-confirmed facts. The
existing local deterministic gates remain final for those decisions.

## Why Jev fits this boundary

TypeSafe describes System One as a model class that evaluates text or structured state and
returns typed `Choice`, `Score`, and `Noul` answers rather than generated text. `Choice`
returns an option, probability distribution, and confidence; `Score` returns a level and
distribution; `Noul` returns a yes probability. These outputs fit bounded routing and
classification, while Athena still needs its current generative model to compose natural
language responses and use tools. A request can ask several independent typed questions
over the same state in one call; Athena uses this capability for route and speech-act
classification without sending more than the current redacted user request. A typed
response constrains the output shape; it does not guarantee that the selected category is
semantically correct, so local source verification and confidence gates remain necessary.

As checked on 2026-09-23, the model page lists Jev 1.13 (`jev-1.13.0`) at $0.042 per
million input tokens, output tokens free, with a 64k total context limit and 32k limit for
state plus the longest question. Published request/token limits are dynamic and may change.
The `jev-latest` alias can move to a new model; keep the versioned ID pinned and rerun the
synthetic evaluation before upgrading. The SDK supports Node.js 20+, matching Athena's
minimum runtime. Decision calls write content-free outcome, elapsed-time, and token-count
events to the local run trace. Debug request logging is disabled because the SDK can log
request bodies at debug level.

TypeSafe states that it does not train or fine-tune on customer input. Its privacy policy
also says it may retain personal data as reasonably necessary to provide or support the
service, may disclose input to service providers, and hosts the service in the United
States. That policy is not a zero-retention guarantee. The product owner authorized the
bounded current-request routing and speech-act classification path; recheck the current
agreement before materially changing the payload scope or provider configuration.

## Evaluation and release gates

1. Build a synthetic corpus covering direct and implied continuation, dates, corrections,
   multiple projects, ordinary new requests, ambiguous requests, and adversarial text.
   The checked-in calibration, 14-case phrasing holdout, three boundary sets, and fresh
   42-case audit are complete. The local proxy baseline is the intent
   inferred by the deterministic ranker used in the manual preview and answer-time source
   ranking; it is not a measure of the Jev route or answer quality. See
   [the calibration snapshot](../calibration.md).
2. Run `pnpm exec tsx bench/jev-recall-evaluation.ts` with `TYPESAFE_API_KEY` to compare
   Jev against six synthetic corpora. It measures raw and confidence-gated per-route
   precision, coverage, misclassified synthetic IDs, no-recall false positives,
   multiclass Brier score, latency, input/output tokens, and estimated cost. The latest
   2026-09-23 run scored 236/238 raw exact; at the 0.98 action threshold, 170/170 accepted
   decisions were exact (71.4% coverage), with no no-recall false positives. The small
   synthetic sets do not establish representative live-history quality. See the calibration
   snapshot for full metrics and limits.
3. Run `pnpm exec tsx bench/jev-speech-act-evaluation.ts` with `TYPESAFE_API_KEY` to
   measure all nine speech-act labels, high-confidence persisted-label precision, confidence
   frontiers, fallback reasons, coverage, macro F1, calibration, latency, and token counts
   against the 72-case calibration set and separate 18-case holdout. The latest runs
   returned 89/90 raw exact labels with no fallback; at the 0.98 persistence threshold,
   35/35 eligible persisted-label decisions were correct (38.9% combined coverage). No
   historical user text was sent in either evaluation.
4. Tests fake the SDK HTTP boundary. They verify no call while disabled or without a key,
   exact allowed payload fields, redaction, model pinning, strict response validation,
   token-only telemetry, timeout/rate-limit fallback, and ephemeral system-prompt use.
5. Dogfood with synthetic data for correctness and with user-authorized scoped history
   only when exercising a real current recall request. Review false positives, no-hits,
   source integrity, project scope, and the answer-provider payload.
6. The product owner has selected global default enablement. Keep the key absent or set
   `jev.enabled` to `false` to disable calls; reevaluate before changing the pinned model.

## Alternatives

| Option | Assessment |
|---|---|
| Keep routing entirely deterministic | Safe local baseline with no added vendor boundary; preserve it as a fallback and comparison point. |
| Ask the generative model to classify recall intent | Can produce free-form behavior and couples routing to answer-model/tool-selection latency; retain it as the conversational answer path. |
| Use Jev to generate memory summaries or answers | Does not fit Jev's typed decision output and would not preserve Athena's source-context contract. |
| Let Jev promote memory, delete data, or bypass local policy | Rejected; these decisions require source verification and explicit user control. |
| Use Jev for bounded route and speech-act decisions in one call | Selected and implemented with local source authority and review-only candidates; synthetic live evaluations are documented in the calibration snapshot. |

## Official research sources

- [TypeSafe announcement: System One models and Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev)
- [TypeSafe OpenAPI specification](https://api.typesafe.ai/openapi.json)
- [TypeSafe API reference](https://api.typesafe.ai/docs)
- [System One](https://docs.typesafe.ai/concepts/system-one)
- [Primitives (Choice, Score, Noul)](https://docs.typesafe.ai/primitives)
- [Confidence](https://docs.typesafe.ai/confidence)
- [Models, aliases, context, and current pricing](https://docs.typesafe.ai/models)
- [JavaScript SDK and Node.js requirement](https://docs.typesafe.ai/sdk/javascript)
- [TypeSafe privacy policy](https://typesafe.ai/legal/privacy-policy)
