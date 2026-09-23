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

- Cold index read, parse, and validation: **339.73 ms**.
- Warm `ContinuityStore.listEpisodes()` plus `searchEpisodes()` median: **41.44 ms**;
  observed range **34.77–54.96 ms**.
- Grouped digest-verified source-context expansion for 5 episodes while enumerating
  10,000 session files: median **25.68 ms**, observed range **22.45–42.23 ms**.
- Warm shared `formatContinuitySearch()` path (search, index, source resolution, digest
  checks, and bounded output) median **31.69 ms**, observed range **25.42–46.20 ms**. This
  is below the 150 ms warm local search target in this synthetic sample.
- Warm local ranking plus all five on-demand rollup granularities: median **523.58 ms**;
  observed range **348.93–561.93 ms**. There is no separate ranking budget yet.

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
