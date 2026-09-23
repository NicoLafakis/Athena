# Conversational Continuity — Synthetic Calibration Snapshot

> [Overview](00-overview.md) · [Tasks](tasks.md) · [Test strategy](test-strategy.md) ·
> [NFR budgets](nfr-budgets.md)

## Scope

This calibration uses generated sessions and episode records only. No personal session
archive was opened. The repeatable gold fixtures live in
[`tests/continuity/calibration.test.ts`](../../../tests/continuity/calibration.test.ts).
Run the synthetic performance sample with `pnpm exec tsx bench/continuity-calibration.ts`.

These results check deterministic behavior. They do not substitute for live dogfood or
subjective usefulness review against representative user histories.

## Jev recall-intent preparation

The balanced, labeled
[`jev-recall-intent.v1.json`](../../../tests/fixtures/continuity/jev-recall-intent.v1.json)
fixture has 49 synthetic requests, seven for each implemented route: `none`,
`continue-current`, `temporal-recall`, `topic-recall`, `preference-or-fact`,
`historical-decision`, and `similar-work`. Labels treat a time phrase as a filter where a
more specific preference or decision is the primary request. The fixture also covers an
ambiguous short follow-up and a quoted recall phrase as non-recall inputs.

Run the deterministic baseline with
`pnpm exec tsx bench/jev-recall-intent-baseline.ts`. It applies the existing ranker's
local `RecallIntent` to the synthetic requests and maps those values to the Jev route
labels. This remains a proxy measurement: the ranker intent is used only for the manual
local ranking preview and is not the Jev model or the answer-time history retriever.

| Proxy metric | Result |
|---|---:|
| Exact route accuracy | **25/49 (51.0%)** |
| Macro F1 | **46.6%** |
| `none` false positives | **7/7 (100%)** |
| Continue-current recall | **42.9%** |
| Temporal-recall recall | **85.7%** |
| Topic-recall recall | **100%** |
| Preference-or-fact recall | **71.4%** |
| Historical-decision recall | **57.1%** |
| Similar-work recall | **0%** |

The proxy always assigns an existing ranker intent, so it cannot abstain on `none`; all
seven ordinary, ambiguous, or quoted-text examples receive a recall label. This result
establishes the local comparison point and demonstrates why the Jev route includes a valid
`none` answer. Jev's selected route now adds a temporary instruction to the answer call,
but it does not load historical source text. The deterministic baseline's full confusion
matrix and fixture are preserved by
[`jev-recall-intent-baseline.test.ts`](../../../tests/continuity/jev-recall-intent-baseline.test.ts).

The pinned-model live evaluator is ready:
`pnpm exec tsx bench/jev-recall-evaluation.ts`. It uses the same 49 synthetic requests and
reports coverage, route precision/recall, no-recall false positives, multiclass Brier
score, median latency, input/output tokens, and estimated input cost. It requires
`TYPESAFE_API_KEY`, sends no personal history, and produces aggregate output only. The key
was not configured during this implementation, so no Jev prediction, quality, latency, or
spend result is claimed. TypeSafe's input price was checked at $0.042 per million tokens
on 2026-09-23; the evaluator labels cost as an estimate at that price.

## Quality results

| Dimension | Fixture result | Interpretation |
|---|---:|---|
| Project/time relevance | MRR **1.00**, Recall@5 **1.00** across 3 labeled queries | The expected episode ranked first for each bounded, project-scoped query; no candidate crossed the requested project or time boundary. |
| Candidate inference | **1/1** eligible direct repeated claim stored; **0** records from paraphrase, tentative, or sensitive negatives | Candidate matching remains exact after punctuation/normalization. It protects precision but intentionally does not generalize paraphrases. |
| Correction handling | **2/2** current/historical checks correct | The corrected value wins for current recall; the superseded value remains findable inside its historical validity window. |
| Time interpretation | **5/5** exact UTC windows from today through year | DST and non-hour-offset behavior remains separately covered by temporal unit tests. |

Candidate quality is measured by explicit fixture labels, not by a statistical sample of
real user statements. No candidate is automatically promoted.

## Local performance sample

Measured on 2026-09-23 on the development host with a synthetic, 10,000-episode,
7,971,559-byte index. Ten warm calls per path were measured after one cold validated read
using the checked-in benchmark script.

- Cold index read, parse, and validation: **232.93 ms**.
- Warm `ContinuityStore.listEpisodes()` plus `searchEpisodes()` median: **23.86 ms**;
  observed range **20.43–45.67 ms**.
- Grouped digest-verified source-context expansion for 5 episodes while enumerating
  10,000 session files: median **24.99 ms**, observed range **21.04–28.95 ms**.
- Warm shared `formatContinuitySearch()` path (search, index, source resolution, digest
  checks, and bounded output) median **22.96 ms**, observed range **21.26–26.03 ms**. This
  is below the 150 ms warm local search target in this synthetic sample.
- Warm local ranking plus all five on-demand rollup granularities: median **270.33 ms**;
  observed range **256.03–302.74 ms**. There is no separate ranking budget yet.

The indexed search and grouped source-verification budgets pass in this generated sample.
It does not model disk contention, very large individual session files, TUI rendering, or
long-lived real project distributions. Index-size ratio and live-history correction rates
remain unmeasured, and subjective usefulness still requires representative-history
dogfood before Phase 4.3 can be marked complete.

## Policy resulting from the review

Repeated inferred sensitive claims stay in their source sessions and are not copied into
semantic candidate bodies. A source message changed by the shared credential redactor is
also excluded from inference. The separate explicit remember path remains available when
the user directly requests it. Candidate evidence remains source-verified and human-reviewed;
the calibration did not relax those rules to increase recall.
