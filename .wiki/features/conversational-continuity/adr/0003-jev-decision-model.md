# ADR 0003: Use Jev as an optional decision model

- **Status:** Proposed; no Jev runtime integration exists.
- **Date:** 2026-09-23
- **Context:** Athena needs to recognize implicit continuity intent and select the
  appropriate local memory path without confusing a conversation model with the memory
  system itself.

## Decision proposal

Treat Jev as an optional, typed decision service beside Athena's generative `ModelClient`.
Do not make it an answer model, memory database, source of truth, or permission authority.
Keep the decision interface separate so the engine's streaming/tool-use contract does not
depend on TypeSafe.

The recommended first integration slice is a recall-intent `Choice` in the harness before
local continuity retrieval. It classifies the current inbound request into a bounded set
such as `none`, `continue-current`, `temporal-recall`, `topic-recall`, `preference-or-fact`,
`historical-decision`, and `similar-work`. Include `none` as a valid answer. Athena then
uses the original request with its local temporal parser, project/sensitivity filters,
live-source checks, deterministic ranker, and bounded source expansion. Jev does not
choose source records or rewrite the query.

For the first slice, send only the shared-redactor-processed current user request and fixed
question definitions. Do not send conversation history, retrieved episodes, summaries,
semantic memory text, source IDs, or project paths. The feature is disabled by default and
requires an explicit Jev setting and credential. Its authorization is separate from any
future choice to send source-verified historical excerpts to an answer provider.

Use TypeSafe's `Choice` probabilities and confidence to decide whether the route is useful
only after an Athena-specific labeled evaluation. Confidence is derived from the returned
probability distribution, and calibration describes groups of predictions rather than
guaranteeing one decision. `Noul` returns a yes probability without a separate confidence
field; do not treat it as an ordered score. Thresholds are risk-specific and must be
measured against Athena's routing outcomes. Invalid or unknown choices, low-confidence
answers, timeouts, missing credentials, rate limits, and provider errors fall through to
the existing local behavior and never block a user turn.

After routing proves useful, evaluate a separate memory-intake experiment. Jev may label
whether persisted user-authored text appears to express a preference, decision, promise,
correction, or tentative thought. Athena must still derive source IDs and timestamps from
its own records, reverify the exact source and context, enforce sensitivity and
independent-evidence rules, and store inferred results as reviewable candidates. Only the
user may promote or reject them. Jev cannot change source history or automatically promote
memory.

Never give Jev authority to decide project trust, permission, tool execution, source
retention, forgetting, deletion, credential handling, or user-confirmed facts. The
existing local deterministic gates remain final for those decisions.

## Why Jev fits this boundary

TypeSafe describes System One as a model class that evaluates text or structured state and
returns typed `Choice`, `Score`, and `Noul` answers rather than generated text. `Choice`
returns an option, probability distribution, and confidence; `Score` returns a level and
distribution; `Noul` returns a yes probability. These outputs fit bounded routing and
classification, while Athena still needs its current generative model to compose natural
language responses and use tools. A request can ask several independent questions over
the same state in one call, though the first recall slice should remain narrow and easy to
evaluate.

As checked on 2026-09-23, the model page lists Jev 1.13 (`jev-1.13.0`) at $0.042 per
million input tokens, output tokens free, with a 64k total context limit and 32k limit for
state plus the longest question. Published request/token limits are dynamic and may change.
The `jev-latest` alias can move to a new model; pin the version used in evaluation and
recalibrate before upgrading. The official JavaScript SDK supports Node.js 20+, matching
Athena's declared minimum runtime. The repository has no TypeSafe dependency or adapter at
this ADR's date. Review the SDK's logging defaults before adoption; its documentation says
debug logging can include request bodies.

TypeSafe states that it does not train or fine-tune on customer input. Its privacy policy
also says it may retain personal data as reasonably necessary to provide or support the
service, may disclose input to service providers, and hosts the service in the United
States. That policy is not a zero-retention guarantee. Recheck the current agreement and
user consent before enabling any external call.

## Evaluation and release gates

1. Build a synthetic corpus covering direct and implied continuation, dates, corrections,
   multiple projects, ordinary new requests, ambiguous requests, and adversarial text.
2. Compare Jev with Athena's current local routing baseline. Measure class precision/recall,
   no-recall false positives, confidence calibration, latency, token count, and estimated
   cost. Define acceptance thresholds before testing; do not import example confidence
   cutoffs from vendor documentation.
3. Fake the HTTP/SDK boundary in integration tests. Verify disabled mode performs zero
   calls, the payload contains only allowed fields, response values are schema-checked,
   and every failure takes a local fallback.
4. Dogfood with synthetic or separately authorized text before using representative live
   histories. Historical episode text requires its own explicit authorization.
5. Pin the tested model ID and keep Jev disabled by default until the product owner opts
   into this additional provider path.

## Alternatives

| Option | Assessment |
|---|---|
| Keep routing entirely deterministic | Safe local baseline with no added vendor boundary; measure its quality first. |
| Ask the generative model to classify recall intent | Can produce free-form behavior and couples routing to answer-model/tool-selection latency; retain it as the conversational answer path. |
| Use Jev to generate memory summaries or answers | Does not fit Jev's typed decision output and would not preserve Athena's source-context contract. |
| Let Jev promote memory, delete data, or bypass local policy | Rejected; these decisions require source verification and explicit user control. |
| Add optional Jev recall routing, then separately evaluate candidate labeling | Recommended proposal; bounded decisions, local source authority, and measurable rollout. |

## Official research sources

- [System One](https://docs.typesafe.ai/concepts/system-one)
- [Primitives (Choice, Score, Noul)](https://docs.typesafe.ai/primitives)
- [Confidence](https://docs.typesafe.ai/confidence)
- [Models, aliases, context, and current pricing](https://docs.typesafe.ai/models)
- [JavaScript SDK and Node.js requirement](https://docs.typesafe.ai/sdk/javascript)
- [TypeSafe privacy policy](https://typesafe.ai/legal/privacy-policy)
