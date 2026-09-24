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
fixture has 56 synthetic requests, eight for each implemented route: `none`,
`continue-current`, `temporal-recall`, `topic-recall`, `preference-or-fact`,
`historical-decision`, and `similar-work`. Labels treat a time phrase as a filter where a
more specific preference or decision is the primary request. It also distinguishes broad
time summaries from specific decisions, immediate same-conversation interruption context,
vague backward references, and quoted recall text used as an example.

Run the deterministic baseline with
`pnpm exec tsx bench/jev-recall-intent-baseline.ts`. It applies the existing ranker's
local `RecallIntent` to the synthetic requests and maps those values to the Jev route
labels. This remains a proxy measurement: the ranker intent is used for the manual local
ranking preview and as one deterministic ranking input to answer-time history retrieval;
it is not the Jev model and does not measure answer-time relevance quality.

| Proxy metric | Result |
|---|---:|
| Exact route accuracy | **31/56 (55.4%)** |
| Macro F1 | **50.1%** |
| `none` false positives | **8/8 (100%)** |
| Continue-current recall | **50.0%** |
| Temporal-recall recall | **100%** |
| Topic-recall recall | **100%** |
| Preference-or-fact recall | **75.0%** |
| Historical-decision recall | **62.5%** |
| Similar-work recall | **0%** |

The proxy always assigns an existing ranker intent, so it cannot abstain on `none`; all
eight ordinary, ambiguous, or quoted-text examples receive a recall label. This result
establishes the local comparison point and demonstrates why the Jev route includes a valid
`none` answer. Jev's route is only an intent hint. Athena uses it to select a local,
source-verifying retrieval path; for an explicit current history request, only bounded,
redacted, source-verified excerpts are sent to the configured answer model. Jev receives
no historical text. The deterministic baseline's full confusion matrix and fixture are preserved by
[`jev-recall-intent-baseline.test.ts`](../../../tests/continuity/jev-recall-intent-baseline.test.ts).

The pinned-model live evaluator is:
`pnpm exec tsx bench/jev-recall-evaluation.ts`. It runs the 56-case calibration fixture,
the separate 14-case phrasing holdout, three disjoint 42-case boundary sets, and a fresh
42-case audit. It reports raw and confidence-gated per-route precision, coverage, synthetic
misclassification IDs, no-recall false positives, multiclass Brier score, median latency,
token counts, and estimated input cost. It requires `TYPESAFE_API_KEY`, sends generated
request text only, and produces aggregate output without source history. On 2026-09-23,
Jev 1.13.0 returned 236/238 exact raw route labels (99.2%). At the production confidence
gate of >= 0.98, all 170 eligible decisions were exact (100.0% precision) across the six
synthetic sets; coverage was 71.4%. No `none` example became a recall action. Both raw
misclassifications were below the gate: `similar-athena` (similar-work -> none, 0.43) and
`challenge-fact-cloud-provider` (preference-or-fact -> historical-decision, 0.69).

| Corpus | Cases | Raw exact | Exact at >= 0.98 | Gate coverage | `none` false positives (raw; gated) | Median latency | Input / output tokens |
|---|---:|---:|---:|---:|---:|---:|---:|
| Calibration | 56 | **55/56 (98.2%)** | **38/38 (100%)** | **67.9%** | **0/8; 0/5** | 190.4 ms | 92,110 / 9,642 |
| Phrasing holdout | 14 | **14/14 (100%)** | **10/10 (100%)** | **71.4%** | **0/2; 0/0** | 194.6 ms | 23,034 / 2,412 |
| Boundary development/calibration | 126 | **125/126 (99.2%)** | **94/94 (100%)** | **74.6%** | **0/18; 0/7** | 194.3 ms | 207,532 / 21,695 |
| Fresh boundary audit | 42 | **42/42 (100%)** | **28/28 (100%)** | **66.7%** | **0/6; 0/1** | 191.8 ms | 69,193 / 7,228 |
| **Combined** | **238** | **236/238 (99.2%)** | **170/170 (100%)** | **71.4%** | **0/34; 0/13** | — | **391,869 / 40,977** |

Estimated input cost for the combined run was $0.01646 at the checked price of $0.042 per
million input tokens. The 0.98 gate retained 170 of 238 route decisions and rejected 68;
it produced no false positives in this synthetic sample. The measured precision is not a
statistical guarantee for real conversations.

The route contract now prioritizes a specific preference, fact, or decision over its time
filter; directs immediate same-conversation context to `continue-current`; treats vague
backward references and quoted recall examples according to the outer request; and uses
`topic-recall` for a request to find a discussion rather than asking what choice was made.
One case was relabeled from temporal to historical-decision because “What did we decide
last quarter?” asks for a specific decision and uses the quarter as scope.

The calibration corpus was used to refine this route contract. The phrasing holdout uses
separate wording and was not used to diagnose the final topic/decision refinement. All six
corpora are synthetic; they do not establish accuracy or false-positive rates on
representative real histories. Phase 4.3 dogfood remains open. TypeSafe's input price was
checked at $0.042 per million tokens on 2026-09-23; costs are estimates at that price.

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

The production speech-act persistence gate is >= 0.98. The final 2026-09-23 runs returned:

| Corpus | Exact raw decisions | Persisted-label precision at >= 0.98 | Persisted-label coverage | All-label exact at >= 0.98 | Median latency | Input / output tokens |
|---|---:|---:|---:|---:|---:|---:|
| Calibration, 72 cases | **72/72 (100%)** | **30/30 (100%)** | **41.7%** | **49/49 (100%)**, 68.1% coverage | 198.4 ms | 118,416 / 12,374 |
| Holdout, 18 cases | **17/18 (94.4%)** | **5/5 (100%)** | **27.8%** | **10/10 (100%)**, 55.6% coverage | 195.0 ms | 29,615 / 3,087 |
| **Combined** | **89/90 (98.9%)** | **35/35 (100%)** | **38.9%** | **59/59 (100%)**, 65.6% coverage | — | **148,031 / 15,461** |

The one raw holdout error was `holdout-decided-source-links` (decided -> preferred,
confidence 0.42), below the persistence gate. No provider fallbacks occurred. For context,
the current all-label confidence frontier is exact at each measured cutoff: calibration
coverage is 93.1% / 88.9% / 80.6% / 68.1% at 0.85 / 0.90 / 0.95 / 0.98; holdout coverage
is 88.9% / 77.8% / 72.2% / 55.6%. The production policy only persists eligible speech
acts, yielding 35 accepted labels across 90 examples. These small synthetic sets do not
establish equivalent accuracy on real-user language.

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
