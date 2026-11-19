# Evidence register and source freshness

[Overview](00-overview.md)

## Local source inspection, 2026-11-16

Primary checkout: `C:\programming\nicos-apps\Athena`, main `5257b318e36d09c7629b6371a5f8c0be2720877a`. Continuity worktree: `C:\Users\Nico\.codex\worktrees\conversational-continuity\Athena`, branch `codex/conversational-continuity` at `4e019402022afac24614e5f4f3f07150842977bc`. Both were clean before this package. Source inspection used read-only git commands and file reads, not runtime/provider calls.

Read repo `AGENTS.md`, `ARCHITECTURE.md`, package scripts, `.wiki/INDEX.md`, existing continuity planning structure, main's controller, model loop/context, skill tool, agents, experience retrieval, journal consolidation, library runtime, learning evaluation/promotion, investigation verifier, interaction detector surfaces and computer-use scope. Used `git show` to inspect branch-specific settings, client, Jev transport, controller/engine integration, answer-time recall, ADR 0003 and calibration history. Branch ownership/status and model installation were not assumed from directory names.

Main and continuity are 37/33 exclusive commits apart; locally cached origin continuity matches its local tip. Server freshness was not checked. The externally referenced `NicoLafakis/Codex/projects/athena.md` page could not be retrieved by web tool, so no claims here depend on it. Local branch source independently establishes the integration.

No `.env`, credential files, personal session archive or API-key value was read. No project/runtime code execution, live inference, app launch, dependency change, commit, push, merge, deployment or activation was part of the research.

## Official TypeSafe sources checked

These support capability/limitations only, not Athena-specific results. Pages are mutable; recheck before implementation and record exact model/SDK and policy versions. All application architecture choices and proposed budgets in this package are Athena design judgments.

- [Documentation index](https://docs.typesafe.ai/llms.txt): discovery of official primitives, patterns, API, SDK, legal and cookbook pages.
- [Introduction](https://docs.typesafe.ai/introduction): Jev is a typed decision model rather than a text generator. It belongs beside the answer model, not in place of it.
- [Primitives](https://docs.typesafe.ai/primitives): Choice, Score and Noul shapes; independent questions; companion applicability check; batching; genuine dependencies need later calls. The newest docs also describe Box, not in this scope.
- [Confidence](https://docs.typesafe.ai/confidence): distinguish distribution concentration from probability/observed correctness and calibrate domain cutoffs.
- [Models](https://docs.typesafe.ai/models): on inspection, `jev-1.14.0` is newest and `jev-latest` points to it; `jev-1.13.0` remains documented. Both listed at $0.042/M input tokens, output free, default 64k request/32k question limits. Long-context expansion is opt-in and discouraged when unnecessary. This is a dated source fact, not a rate quote guaranteed at release or a reason to enlarge Athena payloads.
- [System One API](https://docs.typesafe.ai/api/system-one): `POST /v1/systemone`, model/state/questions request, typed answers, actual response model and usage.
- [Request rules/errors](https://docs.typesafe.ai/api/errors): UTF-8 JSON, finite numbers, request validation, authentication, rate limit and overload semantics. Athena deliberately imposes much smaller limits and zero foreground retries.
- [Model jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13): counting/math/date comparison, distracting context, adversarial content, indirection, option order and generation limits. Use exact code and independent safety controls.
- [Skill suggestion cookbook](https://docs.typesafe.ai/cookbooks/skill_suggestion): a staged narrow skill suggestion pattern; its external benchmark is not an Athena result and its thresholds are not copied.
- [RAG passage cookbook](https://docs.typesafe.ai/cookbooks/classifying_rag_passages): relevance, evidence and contradiction dimensions; motivates a later bounded experiment, not historical upload permission.
- [Legal hub](https://docs.typesafe.ai/legal), [privacy policy](https://typesafe.ai/legal/privacy-policy), [DPA](https://typesafe.ai/legal/data-processing): no-training promise is distinct from retention and subprocessors; enterprise ZDR must be verified for the actual account.

The how-to-build conceptual URL and one verify-output cookbook URL were inaccessible through web tools. The official primitives, model limitations and retrieved cookbook material supplied enough evidence for this plan; no unsupported details were inferred from the failed pages.

## Documentation-only verification

This package must be reviewed for local-link resolution, source-path correctness, whitespace and docs-only diff scope. It does not certify code behavior. Unit/integration tests and four code gates are intentionally not substitutes for documentation review and are not claimed run here. Future implementation verification is specified in [evaluation](evaluation.md).
