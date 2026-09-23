# ADR 0003: Use Jev for Athena's recall routing and speech-act intake

- **Status:** Accepted; pinned recall routing and source-linked speech-act intake are
  integrated into the harness. Live quality and cost evaluation remains pending because no
  TypeSafe credential was configured.
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
local schema. A non-`none` route adds an ephemeral instruction to the active answer-model
system prompt: use only conversation messages present in the turn; if another session or
project is needed, say that its source history is not loaded and point to local memory
search. The route is an intent hint, not evidence that a matching memory exists. Jev does
not automatically retrieve or disclose cross-session episode text.

The TypeSafe request contains only the shared-secret-redactor-processed current user
request and fixed question definitions. It excludes hook-added context, conversation
history, retrieved episodes, summaries, semantic memory text, source IDs, and project
paths. The existing redactor targets known credential fields and secret-shaped tokens; it
does not remove names, general personal information, or arbitrary sensitive prose. The
product owner selected Jev routing on 2026-09-23. Global `jev.enabled` defaults to `true`
and can be set to `false` in `~/.athena/settings.json`; project settings cannot change it.
The API key is supplied through `TYPESAFE_API_KEY` and is not written to settings or
credentials files. A missing key means no network call and a local fallback. This decision
does not authorize historical excerpts to the configured answer provider; that separate
answer-time handoff remains pending.

The adapter pins model `jev-1.13.0` through TypeSafe JavaScript SDK `0.6.0`, disables SDK
request logging and retries, and enforces a one-second outer deadline with a 900 ms
per-attempt SDK timeout. Requests longer than 12,000 characters are skipped. Invalid or
unknown choices, malformed probabilities, timeouts, missing credentials, rate limits, and
provider errors fall through to the ordinary answer path. A route hint is transient and is
not saved in session messages. TypeSafe confidence and probabilities are retained for
evaluation but there is no calibrated confidence threshold yet; current route use follows
the explicit product decision and must be reviewed against the synthetic live evaluation.
`Noul` returns a yes probability without a separate confidence field; do not treat it as an
ordered score.

The product owner explicitly approved memory intake on 2026-09-23. Speech-act
classification is persisted only after Athena writes the current user message. Athena
resolves the source ID, timestamp, and line digest from its own session journal, then stores
a content-free local event for `preferred`, `decided`, `promised`, `corrected`, or
`retracted` labels when Jev confidence is at least 0.85. The event is accepted into an
episode only while it resolves to that exact user-authored line and digest.

Verified `preferred`, `decided`, and `promised` labels can support a candidate when the
same normalized user text appears in two or more independent sessions. Candidate generation
still applies redaction, sensitivity, completeness, and source-integrity checks. Promotion
rechecks the exact source lines. `corrected` and `retracted` labels are kept with their
episode context to help retrieval, but they do not automatically supersede, promote, or
delete semantic memory. A balanced 36-case synthetic corpus and live evaluator cover the
typed speech-act labels. Live precision remains unmeasured until `TYPESAFE_API_KEY` is
configured.

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
classification without sending more than the current redacted user request.

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
   The checked-in 49-case fixture is complete. Its current local baseline is the intent
   inferred inside the manual ranking preview, not an answer-time router; see
   [the calibration snapshot](../calibration.md).
2. Run `pnpm exec tsx bench/jev-recall-evaluation.ts` with `TYPESAFE_API_KEY` to compare
   Jev against the 49-case synthetic corpus. It measures route precision/recall, coverage,
   no-recall false positives, multiclass Brier score, latency, input/output tokens, and
   estimated cost. This live run was not possible during integration because the key was
   absent; no live Jev quality result is claimed.
3. Run `pnpm exec tsx bench/jev-speech-act-evaluation.ts` with `TYPESAFE_API_KEY` to
   measure all nine speech-act labels, high-confidence persisted-label precision, coverage,
   macro F1, calibration, latency, and token counts against the 36-case synthetic corpus.
   This live run has not occurred; no quality result is claimed.
4. Tests fake the SDK HTTP boundary. They verify no call while disabled or without a key,
   exact allowed payload fields, redaction, model pinning, strict response validation,
   token-only telemetry, timeout/rate-limit fallback, and ephemeral system-prompt use.
5. Dogfood with synthetic or separately authorized text. Historical episode text requires
   its own explicit authorization before it enters any provider prompt.
6. The product owner has selected global default enablement. Keep the key absent or set
   `jev.enabled` to `false` to disable calls; reevaluate before changing the pinned model.

## Alternatives

| Option | Assessment |
|---|---|
| Keep routing entirely deterministic | Safe local baseline with no added vendor boundary; preserve it as a fallback and comparison point. |
| Ask the generative model to classify recall intent | Can produce free-form behavior and couples routing to answer-model/tool-selection latency; retain it as the conversational answer path. |
| Use Jev to generate memory summaries or answers | Does not fit Jev's typed decision output and would not preserve Athena's source-context contract. |
| Let Jev promote memory, delete data, or bypass local policy | Rejected; these decisions require source verification and explicit user control. |
| Use Jev for bounded route and speech-act decisions in one call | Selected and implemented with local source authority and review-only candidates; live evaluation remains pending. |

## Official research sources

- [System One](https://docs.typesafe.ai/concepts/system-one)
- [Primitives (Choice, Score, Noul)](https://docs.typesafe.ai/primitives)
- [Confidence](https://docs.typesafe.ai/confidence)
- [Models, aliases, context, and current pricing](https://docs.typesafe.ai/models)
- [JavaScript SDK and Node.js requirement](https://docs.typesafe.ai/sdk/javascript)
- [TypeSafe privacy policy](https://typesafe.ai/legal/privacy-policy)
