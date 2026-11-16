# Evaluation and release acceptance

[Overview](00-overview.md) | [Rollout](tasks-and-rollout.md)

## Evidence discipline

No live call or executable evaluation was run for this planning package. Historical branch synthetic results are in [existing integration](existing-integration.md). Do not relabel synthetic quality as real-history precision, quoted vendor latency as Helios latency, mocked transport as model quality, or green unit tests as end-to-end acceptance. Representative-history dogfood remains explicitly deferred until owner direction and enough history exist.

## Offline tests first

Use fake transport at `tests/decision` and real serialized HTTP-boundary fixtures, never actual credentials. Run through each shared-controller caller: TUI, screen-reader, headless exec and voice. Child-agent use stays disabled unless independently included in the approved design.

Required negative cases:

- Disabled/missing key/unapproved payload class produces zero calls; invalid settings cannot enable new features.
- Exact allowlisted fields only; paths, prior turns, credential-like canaries, headers, env values, raw tool results and historical data cannot slip into current-request payloads.
- At cap, cap+1, Unicode bytes versus characters, deeply nested DTO, empty/redacted-away input; oversize input falls back without truncation-induced reclassification.
- Missing/extra question, unknown label, wrong answer type, NaN/Infinity, out-of-range values, invalid mass, inconsistent selected label, wrong actual model, malformed token usage.
- Timeout, ignored abort, cancellation, simultaneous disable, project switch, changed source, delayed response after next turn, rate limit/overload, unauthorized key and SDK setup exception.
- Per-root reservations under concurrency, failed/unknown usage, retry count zero, circuit state, no budget reset from child creation, cache scope/revision/policy invalidation.
- Explicit no-history requests, vague references, quoted examples, nested role attacks, polite preferences versus commitments, corrections/retractions, multi-intent requests, and negative applicability.
- Suggestions do not load unknown or newly untrusted skills, change available tools, override an explicit skill, cross a project fence, promote memory, suppress counterevidence or bypass actual verification.
- Content-free output across SDK logging, trace, VMP, exceptions, CLI diagnostics and test snapshots.

Use the existing synthetic fixtures in `tests/fixtures/continuity`, existing `bench/jev-*` helpers, and domain-specific new fixtures. Do not send the user's actual sessions to an evaluator by default. Existing live benchmark commands are not safe offline checks merely because they live in `bench`.

## Labeled model-quality experiment, only after approval

1. Author and deduplicate by semantic template and source family before splitting. Separate development, threshold-calibration and untouched independent holdout. Include multilingual, short/long, misspelled, ambiguous, mixed-intent, quoted and adversarial text, plus no-fit examples and near-neighbor skills. Two human reviewers adjudicate disagreements without seeing model output. Do not treat a generative judge as the only gold label.
2. Minimum initial holdout: 300 current-request examples with at least 30 ordinary/no-fit cases and 20 per actionable class; skill set includes at least 100 no-skill/near-fit cases. These are starting sample budgets, not sufficient evidence for a universal high-precision claim. Report denominators and uncertainty intervals. Rare safety failures require adversarial deterministic assertions, not only average accuracy.
3. Compare exact same inputs with existing deterministic/current production path, pinned 1.13 baseline, optional pinned candidate model, and generative classification only if justified and separately budgeted. Freeze prompts, policies and test hash before scoring. Repeated trials and option-order permutations check stability; keep template-related samples in one split.
4. Report confusion matrices; per-class precision/recall/F1; no-fit false-positive rate; accepted-set precision versus coverage; Brier/reliability plots; abstention/fallback reasons; p50/p95/p99 latency; requests/tokens/actual estimated spend; total task success and downstream wrong skill loads. Include all failed requests in denominators. A lower cost caused by refusing everything is not an improvement.
5. For retrieval later, use locally reviewed expected relevant source IDs and counterevidence: MRR/Recall@k/nDCG, supported-claim precision, contradictory-evidence retention, project/source freshness violations and answer correctness. Separate routing correctness, retrieval relevance, source validity and generated-answer faithfulness.

## Proposed go/no-go criteria

All safety/privacy invariants must pass with zero unauthorized transmissions or authority escalations. No useful-quality metric compensates for a leak or bypass.

| Stage | Acceptance bar |
|---|---|
| P0 reconciliation | Existing deterministic/mock suites preserved; old thresholds and current-request boundary unchanged; no regression of library, journal, investigation, permission or session deletion behavior. |
| P1 suggestion holdout | >= 98% accepted suggestion precision and >= 50% eligible coverage; zero changes to explicit skill/workflow requests; <= 1% no-fit suggestion rate. Publish 95% intervals and raw counts, not only points. If sample uncertainty is too large, remain shadow. |
| Skill end-to-end pilot | >= 20% relative reduction in wrong/needless skill loads versus baseline, no > 1 percentage-point task-success loss; preserve full skill availability. |
| P2 retrieval/evidence pilot | No cross-scope/stale source acceptance; no dropped required counterevidence; improve retrieval or review precision on frozen labels without > 2-point Recall@k loss. Must demonstrate task benefit, not just judge agreement. |
| All enabled stages | Meet design latency/call/spend limits; fallback completes existing task route; local disable effective immediately; all platform gates pass on exact integrated tree. |

Threshold selection uses calibration split only. If holdout fails, return to development and commission a fresh holdout after changes; do not repeatedly tune against the old holdout and continue calling it independent. High-confidence errors, drift, payload changes or model/SDK/criterion upgrades reopen gates.

## Release receipt

Record exact code/branch/tree, platform/runtime, model/SDK, question/policy versions, dataset hashes/split rules, reviewers, thresholds, raw aggregate counts, intervals, latency/spend, feature scope approval, tests actually run, known failures and rollback rehearsal. Do not store real payloads in published receipts.

Future code commits require repo gates sequentially on the exact staged tree: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`. Cross-platform release requires the six Node 20/22 by OS CI jobs described in `AGENTS.md`. Targeted tests do not replace the full gates; no push/merge/deploy is authorized by this plan.
