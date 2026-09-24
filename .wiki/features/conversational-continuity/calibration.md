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
a 21-case phrasing regression set, three disjoint 42-case boundary sets, a fresh 42-case
audit, and a separate 21-case independent holdout. It reports raw and confidence-gated
per-route precision, coverage, synthetic misclassification IDs, no-recall false positives,
multiclass Brier score, median latency, token counts, and estimated input cost. It requires
`TYPESAFE_API_KEY`, sends generated request text only, and produces aggregate output without
source history. On 2026-09-24, Jev 1.13.0 returned 266/266 exact raw route labels across all
seven corpora. At the production confidence gate of >= 0.98, all 197 eligible decisions were
exact (100.0% precision; 74.1% coverage). No `none` example became a recall action, and
there were no provider fallbacks.

| Corpus | Cases | Raw exact | Exact at >= 0.98 | Gate coverage | `none` false positives (raw; gated) | Median latency | Input / output tokens |
|---|---:|---:|---:|---:|---:|---:|---:|
| Calibration | 56 | **56/56 (100%)** | **41/41 (100%)** | **73.2%** | **0/8; 0/5** | 202.4 ms | 107,006 / 9,643 |
| Phrasing regression | 21 | **21/21 (100%)** | **16/16 (100%)** | **76.2%** | **0/3; 0/1** | 202.9 ms | 40,133 / 3,618 |
| Boundary development/calibration | 126 | **126/126 (100%)** | **97/97 (100%)** | **77.0%** | **0/18; 0/7** | 206.6 ms | 241,048 / 21,695 |
| Fresh boundary audit | 42 | **42/42 (100%)** | **29/29 (100%)** | **69.0%** | **0/6; 0/1** | 201.6 ms | 80,365 / 7,227 |
| Independent holdout | 21 | **21/21 (100%)** | **14/14 (100%)** | **66.7%** | **0/3; 0/0** | 206.9 ms | 40,173 / 3,617 |
| **Combined** | **266** | **266/266 (100%)** | **197/197 (100%)** | **74.1%** | **0/38; 0/14** | — | **508,725 / 45,800** |

Estimated input cost for the combined run was $0.02137 at the checked price of $0.042 per
million input tokens. The 0.98 gate retained 197 of 266 route decisions and rejected 69;
it produced no false positives in this synthetic sample. The measured precision is not a
statistical guarantee for real conversations.

The route contract now prioritizes a specific preference, fact, or decision over its time
filter; directs immediate same-conversation context to `continue-current`; treats vague
backward references and quoted recall examples according to the outer request; and uses
`topic-recall` for a request to find a discussion rather than asking what choice was made.
One case was relabeled from temporal to historical-decision because “What did we decide
last quarter?” asks for a specific decision and uses the quarter as scope.

The calibration corpus and expanded phrasing regression set were used while refining this
route contract. The separate independent holdout was authored after prompt freeze and was
not used for tuning. All seven evaluated corpora are synthetic; they do not establish
accuracy or false-positive rates on representative real histories. Phase 4.3 dogfood remains
open. TypeSafe's input price was checked at $0.042 per million tokens on 2026-09-23; costs
are estimates at that price.

## Jev speech-act intake

The balanced calibration
[`jev-speech-act.v1.json`](../../../tests/fixtures/continuity/jev-speech-act.v1.json)
contains 72 synthetic current-request examples, eight for each typed Jev label. The
27-case phrasing regression set and separate 27-case independent holdout each have three
cases per label:
[`jev-speech-act-holdout.v1.json`](../../../tests/fixtures/continuity/jev-speech-act-holdout.v1.json)
and
[`jev-speech-act-independent-holdout.v1.json`](../../../tests/fixtures/continuity/jev-speech-act-independent-holdout.v1.json).
Both cover `none`, `asked`, `stated`, `considered`, `preferred`, `decided`, `promised`,
`corrected`, and `retracted`. Run all three corpora with `pnpm exec tsx
bench/jev-speech-act-evaluation.ts`.
The evaluator reports coverage, per-label precision/recall/F1, macro F1, Brier score,
high-confidence persistence precision, exact-label confidence frontiers, fallback reasons,
misclassified synthetic IDs, latency, and token counts. It requires `TYPESAFE_API_KEY`
and sends synthetic text only. The outer decision budget is now two seconds, with a
1.9-second SDK attempt timeout and SDK retries disabled.

The production speech-act persistence gate is >= 0.98. The final 2026-09-24 runs returned:

| Corpus | Exact raw decisions | Persisted-label precision at >= 0.98 | Persisted-label coverage | All-label exact at >= 0.98 | Median latency | Input / output tokens |
|---|---:|---:|---:|---:|---:|---:|
| Calibration, 72 cases | **72/72 (100%)** | **30/30 (100%)** | **41.7%** | **51/51 (100%)**, 70.8% coverage | 203.3 ms | 137,568 / 12,414 |
| Phrasing regression, 27 cases | **27/27 (100%)** | **11/11 (100%)** | **40.7%** | **18/18 (100%)**, 66.7% coverage | 197.9 ms | 51,607 / 4,632 |
| Independent holdout, 27 cases | **27/27 (100%)** | **12/12 (100%)** | **44.4%** | **21/21 (100%)**, 77.8% coverage | 199.3 ms | 51,630 / 4,659 |
| **Combined** | **126/126 (100%)** | **53/53 (100%)** | **42.1%** | **90/90 (100%)**, 71.4% coverage | — | **240,805 / 21,705** |

There were no misclassified examples or provider fallbacks. The independent holdout was
authored after prompt freeze and was not used for tuning. At 0.85 / 0.90 / 0.95 / 0.98, the
all-label confidence-frontier coverage was 93.1% / 87.5% / 83.3% / 70.8% for calibration,
88.9% / 88.9% / 85.2% / 66.7% for phrasing regression, and 92.6% / 92.6% / 81.5% / 77.8%
for the independent holdout. All selected labels at these cutoffs were exact. The production
policy persists 53 eligible labels across 126 examples. These small synthetic sets do not
establish equivalent accuracy on real-user language.

## Limited local-history spot-check

The earlier bounded review found a ranking false positive: a generic word such as “model”
was treated as topical evidence. The ranker now removes recall/intent-only terms before
subject matching and returns no candidate without a matching subject or bounded time
window; regression tests cover both intent-only and specific-but-absent queries.
The current host archive contains 8 session files and 29 indexed episodes across 2 project
partitions, totaling 369,230 source bytes. The episode range is July 23–August 13, 2026,
so the archive covers only two active months. Bounded local search and ranking found some
useful retrieval within a concentrated August voice/permissions topic cluster, but this
cannot establish cross-project breadth, correction rates, or day/week/month/quarter/year
continuity quality. An inventory on 2026-09-24 found eight session files in the configured
global store across two populated project partitions; a path-only sweep found no additional
project-local Athena session archive beneath the development workspace. This confirms the
available corpus is small, not that it represents independent projects.

A follow-up bounded smoke check found one source-verified candidate for a committing-skill
query. A date-and-topic rank query returned five same-day candidates, with the exact
question episode ranked first and no broad rollup selected. An end-to-end answer-time
recall completed in one answer-model call with no tool calls; the returned answer matched
the linked source. That call cost $0.039685. These observations are narrow examples, not
precision estimates: the archive is small and concentrated, and representative multi-project
dogfood remains required before making a 98–100% precision claim.

The compressed index is 30,833 bytes, or 8.35% of source bytes; its prior plain JSON form
was 97,851 bytes, or 26.5%. The under-10% size target is met on this archive only. Neither
this measurement nor the focused spot-check closes Phase 4.3's representative-history
dogfood gate.

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

Measured on 2026-09-24 on the development host with the checked-in benchmark script. The
synthetic index contains 10,000 episodes: 11,321,587 bytes expanded and 394,873 bytes
stored (3.49% of expanded size). Ten warm calls per path were measured after one cold
validated read. All records were generated under a temporary directory; no user archive
was read by this benchmark.

- Cold compressed-index read, decompression, parse, and validation: **250.36 ms**.
- Warm indexed search median: **13.72 ms**, observed range **12.16–21.25 ms**.
- Grouped digest-verified source-context expansion for 5 episodes while enumerating
  10,000 session files: median **29.34 ms**, observed range **22.33–43.58 ms**.
- Warm shared `formatContinuitySearch()` path (search, index, source resolution, digest
  checks, and bounded output): median **45.27 ms**, observed range **38.16–48.02 ms**.
- Warm local ranking plus all five on-demand rollup granularities: median **449.05 ms**;
  observed range **323.66–462.96 ms**. There is no separate ranking budget yet.

Warm indexed search and grouped source expansion remain within their synthetic targets.
The ranking measurement is recorded without a pass claim because no ranking budget exists.
This sample does not model disk contention, very large individual session files, TUI
rendering, or long-lived project distributions. Synthetic performance and the small local
size ratio do not replace representative-history correction-rate and usefulness dogfood;
Phase 4.3 remains open.

## Policy resulting from the review

Repeated inferred sensitive claims stay in their source sessions and are not copied into
semantic candidate bodies. A source message changed by the shared credential redactor is
also excluded from inference. The separate explicit remember path remains available when
the user directly requests it. Candidate evidence remains source-verified and human-reviewed;
the calibration did not relax those rules to increase recall.
