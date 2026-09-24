# Conversational Continuity — Synthetic Calibration Snapshot

> [Overview](00-overview.md) · [Tasks](tasks.md) · [Test strategy](test-strategy.md) ·
> [NFR budgets](nfr-budgets.md)

## Scope

The synthetic calibration below uses generated sessions and episode records only. A
separate, limited local-history spot-check is summarized below without transcript text or
source identifiers. The repeatable gold fixtures live in
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
labels. This remains a proxy measurement: the ranker intent is used for the manual local
ranking preview and as one deterministic ranking input to answer-time history retrieval;
it is not the Jev model and does not measure answer-time relevance quality.

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
`none` answer. Jev's route is only an intent hint. Athena uses it to select a local,
source-verifying retrieval path; for an explicit current history request, only bounded,
redacted, source-verified excerpts are sent to the configured answer model. Jev receives
no historical text. The deterministic baseline's full confusion matrix and fixture are preserved by
[`jev-recall-intent-baseline.test.ts`](../../../tests/continuity/jev-recall-intent-baseline.test.ts).

The pinned-model live evaluator is:
`pnpm exec tsx bench/jev-recall-evaluation.ts`. It uses the same 49 synthetic requests and
reports coverage, route precision/recall, no-recall false positives, multiclass Brier
score, median latency, input/output tokens, and estimated input cost. It requires
`TYPESAFE_API_KEY`, sends no personal history, and produces aggregate output only. The
2026-09-23 live run returned all 49 decisions:

| Measure | Result |
|---|---:|
| Exact route accuracy | **47/49 (95.9%)** |
| No-recall false positives, without confidence gating | **1/7 (14.3%)** |
| Actionable decisions at Athena's 0.85 threshold | **42/49 (85.7%)** |
| Exact actionable decisions | **41/42 (97.6%)** |
| Actionable no-recall false positives | **0/4 (0%)** |
| Macro F1 / multiclass Brier score | **95.9% / 0.0123** |
| Median latency | **239.5 ms** |
| Input / output tokens | **46,132 / 8,451** |
| Estimated input cost | **$0.00194** |

The remaining raw no-recall error fell below the production action threshold. These
results cover only seven synthetic no-recall cases; they do not establish real-history
false-positive rates. TypeSafe's input price was checked at $0.042 per million tokens on
2026-09-23; cost is an estimate at that price.

## Jev speech-act intake

The balanced calibration
[`jev-speech-act.v1.json`](../../../tests/fixtures/continuity/jev-speech-act.v1.json)
contains 72 synthetic current-request examples, eight for each typed Jev label. A separate
18-case
[`jev-speech-act-holdout.v1.json`](../../../tests/fixtures/continuity/jev-speech-act-holdout.v1.json)
set uses different phrasing, with two cases per label:
`none`, `asked`, `stated`, `considered`, `preferred`, `decided`, `promised`, `corrected`,
and `retracted`. Run both sets with `pnpm exec tsx bench/jev-speech-act-evaluation.ts`.
The evaluator reports coverage, per-label precision/recall/F1, macro F1, Brier score,
high-confidence persistence precision, exact-label confidence frontiers, fallback reasons,
misclassified synthetic IDs, latency, and token counts. It requires `TYPESAFE_API_KEY`
and sends synthetic text only. The outer decision budget is now two seconds, with a
1.9-second SDK attempt timeout and SDK retries disabled.

The final 2026-09-23 runs returned:

| Corpus | Exact decisions | Fallbacks | Persisted labels at 0.85 | All-label precision at 0.85 | Median latency | Input / output tokens |
|---|---:|---:|---:|---:|---:|---:|
| Calibration, 72 cases | **72/72 (100%)** | **0** | **37/37 (100%)**, 51.4% corpus coverage | **66/66 (100%)**, 91.7% coverage | 189.2 ms | 75,576 / 12,384 |
| Holdout, 18 cases | **18/18 (100%)** | **0** | **9/9 (100%)**, 50.0% corpus coverage | **17/17 (100%)**, 94.4% coverage | 191.0 ms | 18,905 / 3,102 |

For calibration, every decision at the 0.90, 0.95, and 0.98 confidence cutoffs was also
exact: 64/64 (88.9% coverage), 58/58 (80.6%), and 50/50 (69.4%) respectively. Holdout
results were 14/14 (77.8%), 13/13 (72.2%), and 11/11 (61.1%). The first expanded run
under the earlier one-second budget returned 60 decisions and 12 provider-error fallbacks;
the adapter now identifies TypeSafe timeout errors correctly and uses the two-second budget.
These sets are synthetic and deliberately small (eight calibration examples and two holdout
examples per label); they show a clear improvement on the known boundary errors but do not
establish 98–100% accuracy on real-user language.

## Limited local-history spot-check

A read-only search over the available local archive found no exact `Jev` topic match.
The initial ranking preview still selected unrelated episodes because the generic word
“model” counted as topical evidence. The shared ranker now removes recall/intent-only
terms before subject matching and returns no candidate without a matching subject or
bounded time window. Regression tests cover both an intent-only decision query and a
specific but absent model name. The local archive was too small to establish representative
multi-project usefulness, correction rates, or index-size ratio; those Phase 4.3 checks
remain open.

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
